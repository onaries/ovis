import { useSyncExternalStore } from "react";
import type { PushDeliveryFailure, PushSubscriptionStatus } from "../../shared/protocol.ts";
import { ApiError, fetchPushKey, fetchPushSubscriptionStatus, routeMissing } from "./api.ts";
import { notificationState, type NotificationState } from "./notifications.ts";
import { currentPushOperation, heldPushSubscription, pushSubscriptionEpoch, pushSupported, sameServerKey } from "./push.ts";

/**
 * Whether this device still gets the alerts it asked for, and what to do when it does not.
 *
 * The server keeps the outcome of the last push to each subscription (POST /api/push/status,
 * server/push.ts). This browser's own subscription is looked up on registration, when the app
 * comes to the front and after an explicit test or repair, and the answer is read against what
 * the browser holds. One state serves the notice over the pane and Settings → Alerts, so the two
 * never disagree and no second banner competes with the first.
 *
 * The classifier is pure: it alarms only on a permanent failure strictly newer than the last
 * success, and offers to subscribe anew only where that can help. A transient failure (no
 * answer, throttling, a server error) and one an alert has since gone past are history, not a
 * fault, and no probe push is ever sent to find out. Adapted from Agent of Empires'
 * `web/src/lib/pushHealth.ts` (MIT; THIRD_PARTY_NOTICES.md), with its repair rule narrowed.
 */

/** What stands between this device and its alerts, or null: nothing anyone knows of. */
export type PushProblem = "permission" | "missing" | "gone" | "key-mismatch" | "rejected";

export interface PushHealthInput {
  /** the device asked for alerts: its switch is on */
  wanted: boolean;
  supported: boolean;
  permission: NotificationState;
  /** the browser holds a subscription; false when it was looked at and holds none; null before anyone looked */
  subscribed: boolean | null;
  /** its key is the server's; null when the browser does not say, or there is no subscription */
  keyMatches: boolean | null;
  /** the server's answer for it: null while there is none (not asked, unreachable, an older server), "unknown" when it does not know the subscription */
  status: PushSubscriptionStatus | "unknown" | null;
}

export interface PushHealth {
  problem: PushProblem | null;
  /** subscribing anew mends it (missing, gone, a key mismatch); never a refusal, throttling, a server or network failure or a denied permission */
  repair: boolean;
  /** the newest outcome the server recorded is a transient failure: worth a line in Settings, never a notice */
  transient: PushDeliveryFailure | null;
}

export const QUIET: PushHealth = { problem: null, repair: false, transient: null };

const PERMANENT: ReadonlySet<PushDeliveryFailure> = new Set(["gone", "key-mismatch", "rejected"]);
const permanent = (failure: PushDeliveryFailure): failure is "gone" | "key-mismatch" | "rejected" => PERMANENT.has(failure);

/** A failure strictly after the last success; one at the same time or before it is history. */
export function failureIsNewer(status: PushSubscriptionStatus): boolean {
  if (status.last_failure === null || status.last_failure_at === null) return false;
  if (status.last_success_at === null) return true;
  const failed = Date.parse(status.last_failure_at);
  const succeeded = Date.parse(status.last_success_at);
  return Number.isFinite(failed) && Number.isFinite(succeeded) && failed > succeeded;
}

export function classifyPushHealth(input: PushHealthInput): PushHealth {
  if (!input.wanted || !input.supported) return QUIET;
  if (input.permission === "denied") return { problem: "permission", repair: false, transient: null };
  if (input.permission !== "granted") return QUIET;
  // a subscription made for another server key can never receive a push from this one
  if (input.keyMatches === false) return { problem: "key-mismatch", repair: true, transient: null };
  // alerts wanted and allowed, and the browser holds no subscription: subscribing anew is the mend
  if (input.subscribed === false) return { problem: "missing", repair: true, transient: null };
  const status = input.status;
  // nothing seen is nothing to say
  if (status === null || input.subscribed !== true) return QUIET;
  if (status === "unknown") return { problem: "missing", repair: true, transient: null };
  if (failureIsNewer(status)) {
    const failure = status.last_failure!;
    // the push service refused the server's signature (401/403). With the browser's key proven the server's
    // own above, subscribing anew would make the same subscription, so it is told as a refusal. A key nobody
    // can read (the phone app's, or a browser that does not say) is most likely the old one, after the
    // server's key changed and a registration with the new one failed: subscribing anew replaces a
    // subscription whose key is not proven (lib/push.ts, and the app's plugin on a changed key), so it mends it
    if (failure === "key-mismatch") return input.keyMatches === null ? { problem: "key-mismatch", repair: true, transient: null } : { problem: "rejected", repair: false, transient: null };
    if (permanent(failure)) return { problem: failure, repair: failure === "gone", transient: null };
    return { problem: status.registered ? null : "missing", repair: !status.registered, transient: failure };
  }
  if (!status.registered) return { problem: "missing", repair: true, transient: null };
  return QUIET;
}

/**
 * What Send test or a repair came to, for Settings' line (components/PushTestControls.tsx). A repair
 * that made no subscription says why: the browser (or the app) would not make one ("refused"), the
 * page's service worker never came up ("no-worker"), or the PC did not take it ("unregistered").
 */
export type PushActionResult = "sent" | "unsupported" | "permission" | "missing" | "gone" | "read-only" | "refused" | "no-worker" | "unregistered" | "failed";

const REPAIR_FAILURES: ReadonlySet<PushActionResult> = new Set(["refused", "no-worker", "unregistered"]);

/** A repair that did not mend the fault: its reason is the notice's and Settings' line while that fault stands. */
export const repairFailed = (result: PushActionResult | null): boolean => result !== null && REPAIR_FAILURES.has(result);

/**
 * A result with the subscription it is about: the endpoint tested, or the one a repair registered;
 * null when the action found this device holding none; absent when that is not known, and the next
 * look claims it for the subscription it finds.
 */
export interface PushActionOutcome {
  result: PushActionResult;
  endpoint?: string | null;
}

export interface PushHealthState {
  health: PushHealth;
  /** the test or repair under way, from the notice or Settings: the other waits */
  busy: "test" | "repair" | null;
  result: PushActionResult | null;
  /** the fault whose notice this device closed: Settings still tells it, the notice does not until another fault or a working look */
  dismissed: PushProblem | null;
}

const DISMISSED_KEY = "ovis:push-notice-dismissed";
const PROBLEMS: readonly PushProblem[] = ["permission", "missing", "gone", "key-mismatch", "rejected"];

function readDismissed(fallback: PushProblem | null = null): PushProblem | null {
  try {
    const value = window.localStorage.getItem(DISMISSED_KEY);
    return PROBLEMS.find((problem) => problem === value) ?? null;
  } catch { return fallback; }
}

function writeDismissed(problem: PushProblem | null): void {
  try {
    if (problem) window.localStorage.setItem(DISMISSED_KEY, problem);
    else window.localStorage.removeItem(DISMISSED_KEY);
  } catch { /* storage blocked: the dismissal lasts until the page reloads */ }
}

let state: PushHealthState = { health: QUIET, busy: null, result: null, dismissed: readDismissed() };
const listeners = new Set<() => void>();
/** every refresh takes a number; an answer to an older one is dropped (a later success, disable or new subscription has spoken since) */
let generation = 0;
/** every test or repair takes a number too, and a reset moves it on: an action that ends after a reset or a later action says nothing */
let actions = 0;
/**
 * The subscription Settings' line (`result`) speaks of: the endpoint the first look after the test
 * or repair found, null for none; undefined until that look claims it. A look that finds another
 * subscription (another tab's, or the service worker's renewal) drops the line.
 */
let resultFor: string | null | undefined;

function setState(next: PushHealthState): void {
  state = next;
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== window.localStorage || event.key !== null && event.key !== DISMISSED_KEY) return;
    // Events can be queued behind a newer write: read what stands now, never replay event.newValue.
    const dismissed = readDismissed(state.dismissed);
    if (dismissed !== state.dismissed) setState({ ...state, dismissed });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = (): PushHealthState => state;

export function usePushHealth(): PushHealthState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function readPushHealth(): PushHealthState {
  return state;
}

/** The endpoint this device holds now: null for none, undefined when that cannot be read. */
async function heldEndpoint(): Promise<string | null | undefined> {
  try {
    const subscription = await heldPushSubscription();
    return subscription === undefined ? undefined : subscription?.json.endpoint ?? null;
  } catch {
    return undefined;
  }
}

/**
 * This browser's subscription as it stands, read without changing it; `reached` is false when the
 * PC did not answer at all, and `endpoint` is the one read (null for none, undefined when not looked at).
 */
async function observe(wanted: boolean): Promise<{ input: PushHealthInput; reached: boolean; endpoint: string | null | undefined }> {
  const input: PushHealthInput = { wanted, supported: pushSupported(), permission: notificationState(), subscribed: null, keyMatches: null, status: null };
  if (!input.wanted || !input.supported || input.permission !== "granted") return { input, reached: true, endpoint: undefined };
  let subscription: Awaited<ReturnType<typeof heldPushSubscription>>;
  try {
    subscription = await heldPushSubscription();
  } catch {
    return { input, reached: true, endpoint: undefined };
  }
  // no worker registered yet: there is nothing to look at, which is not a missing subscription
  if (subscription === undefined) return { input, reached: true, endpoint: undefined };
  input.subscribed = subscription !== null;
  if (!subscription) return { input, reached: true, endpoint: null };
  const endpoint = subscription.json.endpoint ?? null;
  try {
    input.keyMatches = sameServerKey(subscription.key, await fetchPushKey());
    if (input.keyMatches === false) return { input, reached: true, endpoint };
    input.status = (await fetchPushSubscriptionStatus(subscription.json)) ?? "unknown";
  } catch (error) {
    // a server from before the question answers 404 for the route, and the open LAN, which signs in as no
    // device, 403 status_unavailable: nothing to go on, and nothing wrong. Any other failure (a 5xx, the PC
    // out of reach) proves nothing either way: what was known stands
    const answered = routeMissing(error) || error instanceof ApiError && error.code === "status_unavailable";
    return { input, reached: answered, endpoint };
  }
  return { input, reached: true, endpoint };
}

/**
 * Looks again, after the subscription operation under way, if any, has settled. `wanted` is
 * the device's alert switch: off, nothing is looked at and nothing is said.
 */
export async function refreshPushHealth(wanted: boolean): Promise<void> {
  const mine = ++generation;
  // the subscription this look reads: the epoch is taken with the operation it waits for, and one begun during
  // that wait (from the operation's own completion, say) is waited for in turn
  let subject: number;
  do {
    subject = pushSubscriptionEpoch();
    await currentPushOperation();
    if (mine !== generation) return;
  } while (subject !== pushSubscriptionEpoch());
  // a registration or removal begun while the look is out replaces what it reads
  const { input, reached, endpoint } = await observe(wanted);
  if (mine !== generation) return;
  // what was read belongs to a subscription since replaced: look again at the one that stands
  if (subject !== pushSubscriptionEpoch()) return refreshPushHealth(wanted);
  // replaced from outside this page's operations while its answer was out (another tab, or the service
  // worker renewing it): the answer is for a subscription this device no longer holds
  if (input.subscribed === true) {
    const now = await heldEndpoint();
    if (mine !== generation) return;
    if (now !== undefined && now !== endpoint) return refreshPushHealth(wanted);
  }
  // the PC out of reach says nothing new: what was known stands, a notice included, until it answers again
  if (!reached) return;
  let health = classifyPushHealth(input);
  // a fault found later is the latest word: the line of an earlier test does not stand beside it, nor
  // does the line of a test or repair of a subscription since replaced. Why a repair failed is about
  // the fault it was meant to mend. No worker or no status answer proves no recovery.
  const working = health.problem === null && input.status !== null && typeof input.status === "object";
  const keepFailure = repairFailed(state.result) && input.wanted && input.supported && input.permission === "granted"
    && !working && (health.problem === null || health.repair && (state.health.problem === null || health.problem === state.health.problem));
  if (keepFailure && health.problem === null) health = state.health;
  let result = (repairFailed(state.result) ? keepFailure : health.problem === null) ? state.result : null;
  if (result !== null && !repairFailed(result) && endpoint !== undefined) {
    if (resultFor === undefined) resultFor = endpoint;
    else if (resultFor !== endpoint) result = null;
  }
  // Read the origin's current value even if this tab has not received its storage event yet.
  const stored = readDismissed(state.dismissed);
  const dismissed = keptDismissal(stored, health, input);
  if (dismissed !== stored) writeDismissed(dismissed);
  setState({ ...state, health, result, dismissed });
}

/**
 * A closed notice stays closed for its fault. Another fault is news, and so is the same one after a
 * look that found alerts working: the server answered for a subscription this device holds. A look
 * that saw nothing (no worker yet, an older server) proves neither, and keeps it.
 */
function keptDismissal(dismissed: PushProblem | null, health: PushHealth, input: PushHealthInput): PushProblem | null {
  if (dismissed === null) return null;
  if (!input.wanted) return null;
  if (health.problem !== null) return health.problem === dismissed ? dismissed : null;
  return typeof input.status === "object" && input.status !== null ? null : dismissed;
}

/** Closes the notice on this device for the fault it tells; Settings → Alerts goes on telling it. */
export function dismissPushNotice(): void {
  const problem = state.health.problem;
  if (problem === null) return;
  writeDismissed(problem);
  setState({ ...state, dismissed: problem });
}

/** Alerts turned off here, or the device locked: nothing is wrong any more, and no answer still out may say otherwise. */
export function resetPushHealth(): void {
  generation += 1;
  actions += 1;
  resultFor = undefined;
  writeDismissed(null);
  setState({ health: QUIET, busy: null, result: null, dismissed: null });
}

/**
 * Runs Send test or a repair, one at a time wherever it was started, and records what it came
 * to; then looks again, so the notice clears on the success the test or repair just proved.
 * `wanted` is read when that look begins: a repair turns the switch on, a disable meanwhile off.
 */
export async function runPushAction(kind: "test" | "repair", action: () => Promise<PushActionResult | PushActionOutcome>, wanted: () => boolean): Promise<void> {
  if (state.busy !== null) return;
  const mine = ++actions;
  setState({ ...state, busy: kind, result: null });
  let result: PushActionResult = "failed";
  let about: string | null | undefined;
  try {
    const outcome = await action();
    result = typeof outcome === "string" ? outcome : outcome.result;
    about = typeof outcome === "string" ? undefined : outcome.endpoint;
  } finally {
    // reset or followed by another action meanwhile: that one's state is not this one's to clear
    if (mine === actions) {
      // the subscription the line is about: the one tested or registered, else the one the look below finds.
      // One replaced while a test was out (another tab) is not the one the line speaks of
      resultFor = about;
      setState({ ...state, busy: null, result });
    }
  }
  if (mine === actions) await refreshPushHealth(wanted());
}
