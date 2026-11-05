/**
 * The PC's mailbox at the account service (docs/account.md, "Account service API"): records left for
 * this PC while it was off. The PC signs in with nothing but its relay key, answering a server proof
 * for the `account` role, which the relay itself never accepts. The service can hold records back,
 * never forge one: each is checked and applied like a record a client hands over directly.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { writePrivateState } from "../private-state.ts";
import { DEFAULT_ACCOUNT_SERVICE } from "../static.ts";
import { ACCOUNT_RECORDS_MAX, isAccountKey } from "../../shared/account-records.ts";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import { applyAccountRecords } from "./records.ts";

export const MAILBOX_PULL_MS = 5 * 60_000;
/** How old an admission may be for the PC to take an account join outside the pairing window. */
export const ADMISSION_TTL_MS = 10 * 60_000;
/** The least time between two pulls a join that missed asks for. */
const ASKED_PULL_MS = 10_000;

function scope(account: string, serverId: string, key: string): string {
  return `${account}\0${serverId}\0${key}`;
}
/** Pages one pull reads at most; the rest waits for the next pull. */
const MAX_PAGES = 20;

export function accountServiceUrl(value = process.env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE): string {
  if (value.trim().toLowerCase() === "off") throw new Error("The account service is turned off (OVIS_ACCOUNT_SERVICE_URL=off)");
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The account service must be https");
  return url.origin;
}

/** Records refused only because their signer was not a member yet, kept across pulls (and restarts) until they apply. */
const PENDING_MAX = 1000;

function readPending(path: string | undefined): unknown[] {
  if (!path) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.slice(-PENDING_MAX) : [];
  } catch { return []; } // absent or unreadable: nothing waits; a record that never applies is the service's to resend
}

export interface AccountMailboxOptions {
  /** Where records waiting on their signer are kept between pulls; tests leave it out and keep them in memory. */
  readonly pendingPath?: string;
  readonly devices: DeviceStore;
  /** This PC's relay identity, when it has one; its `server_id` names the mailbox. */
  readonly identity: () => RelayIdentity | undefined;
  /** The account service's origin, or why none can be used (a bad OVIS_ACCOUNT_SERVICE_URL), shown as the mailbox's error. */
  readonly service: string | Error;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export class AccountMailbox {
  lastPullAt: string | null = null;
  /** The admissions the last pull saw, by account, PC and waiting device's key (`scope`): when each was made. */
  private admissions = new Map<string, number>();
  private lastAskedPull = Number.NEGATIVE_INFINITY;
  error: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pulling: Promise<number> | undefined;

  private pending: unknown[];
  /** The waiting records a pull took out of `pending` to retry, until it puts them back. */
  private draining: unknown[] = [];

  constructor(private readonly options: AccountMailboxOptions) {
    this.pending = readPending(options.pendingPath);
  }

  /** Pulls now unless a pull is under way; how many records changed something. Never throws. */
  pull(): Promise<number> {
    this.pulling ??= this.drain().finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  start(): void {
    if (this.timer) return;
    void this.pull();
    this.timer = setInterval(() => { void this.pull(); }, MAILBOX_PULL_MS);
    this.timer.unref?.();
  }

  /**
   * Whether the account service has an admission at most 10 minutes old naming `key` for this PC's
   * current account and relay identity. A miss pulls again, at most once every 10 seconds, so refused
   * requests cannot make the PC call the service at will.
   */
  async admitted(key: string): Promise<boolean> {
    const fresh = () => {
      const account = this.options.devices.account();
      const identity = this.options.identity();
      if (account === null || !identity) return false;
      const at = this.admissions.get(scope(account, identity.server_id, key));
      const now = Date.now();
      return at !== undefined && now - at < ADMISSION_TTL_MS && at <= now + 60_000;
    };
    if (fresh()) return true;
    if (this.pulling) await this.pulling;
    else if (Date.now() - this.lastAskedPull >= ASKED_PULL_MS) {
      this.lastAskedPull = Date.now();
      await this.pull();
    }
    return fresh();
  }

  /**
   * A `remove` a client relayed (POST /api/account/records) that was refused only because its signer
   * is not a member here yet: kept with the mailbox's own such records, so it applies on the pull after
   * its signer joins (#2956). One already waiting is not kept twice, and none is kept once PENDING_MAX
   * wait: a relayed record never pushes out one that waits already.
   */
  wait(record: unknown): void {
    const waiting = [...this.draining, ...this.pending];
    const text = JSON.stringify(record);
    if (waiting.length >= PENDING_MAX || waiting.some((kept) => JSON.stringify(kept) === text)) return;
    const next = [...this.pending, record];
    // on disk first, with the ones a pull is retrying, so a stop (or a failed write) loses none of them
    if (this.options.pendingPath) writePrivateState(this.options.pendingPath, [...this.draining, ...next]);
    this.pending = next;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<number> {
    const account = this.options.devices.account();
    let identity: RelayIdentity | undefined;
    try { identity = this.options.identity(); } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return 0;
    }
    if (account === null || !identity) return 0;
    if (this.options.service instanceof Error) { this.error = this.options.service.message; return 0; }
    // a removal refused for a local reason would be acknowledged and lost: collect nothing until it is fixed
    if (this.options.devices.accountError !== null) { this.error = this.options.devices.accountError; return 0; }
    let applied = 0;
    let ack: number | null = null;
    // refused because their signer was not a member yet: a later add, in this pull or a later one, may make it one
    const early: unknown[] = this.pending.splice(0);
    this.draining = early;
    /** Until a pass applies nothing more, so a chain of adds read in any order still reaches the remove at its end. */
    const retry = async () => {
      for (let progress = true; progress && early.length;) {
        progress = false;
        for (let start = 0; start < early.length;) {
          const batch = early.slice(start, start + ACCOUNT_RECORDS_MAX);
          // a record leaves the list only once its outcome is known: a failure here keeps every one of them
          const outcomes = await applyAccountRecords(this.options.devices, batch, identity.server_id);
          const keep = batch.filter((_record, index) => outcomes[index]?.outcome === "refused" && (outcomes[index] as { code?: string }).code === "signer_not_member");
          applied += outcomes.filter(({ outcome }) => outcome === "applied").length;
          if (keep.length !== batch.length) progress = true;
          early.splice(start, batch.length, ...keep);
          start += keep.length;
        }
      }
    };
    /** On disk before any page that put a record here is acknowledged, so a stop never loses one. */
    // with any a client relayed meanwhile (wait), which this.pending holds until the pull ends
    const save = () => { if (this.options.pendingPath) writePrivateState(this.options.pendingPath, [...early, ...this.pending].slice(-PENDING_MAX)); };
    try {
      const admissions = new Map<string, number>();
      await retry();
      for (let page = 0; ; page++) {
        // past the last page read, one more call only acknowledges it; what it returns waits for the next pull
        const { entries, waiting } = await this.page(identity, account, ack);
        for (const admission of waiting) admissions.set(scope(account, identity.server_id, admission.key), Date.parse(admission.at));
        if (entries.length === 0 || page === MAX_PAGES) break;
        for (let start = 0; start < entries.length; start += ACCOUNT_RECORDS_MAX) {
          const batch = entries.slice(start, start + ACCOUNT_RECORDS_MAX).map(({ record }) => record);
          const outcomes = await applyAccountRecords(this.options.devices, batch, identity.server_id);
          applied += outcomes.filter(({ outcome }) => outcome === "applied").length;
          outcomes.forEach((outcome, index) => { if (outcome.outcome === "refused" && outcome.code === "signer_not_member") early.push(batch[index]); });
        }
        // before this page is acknowledged (with the next request), retry what waited on a signer, and keep the rest on disk
        await retry();
        save();
        // every record read is acknowledged, refused ones too, so a refused one cannot hold the rest back
        ack = Math.max(...entries.map(({ seq }) => seq));
      }
      // still waiting on a signer: kept for later pulls, the oldest dropped past PENDING_MAX
      save();
      this.pending = [...early, ...this.pending].slice(-PENDING_MAX);
      this.draining = [];
      this.admissions = admissions;
      this.lastPullAt = new Date().toISOString();
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      try { save(); } catch { /* the pull's own error is the one to show; what waits stays in memory */ }
      this.pending = [...early, ...this.pending].slice(-PENDING_MAX);
      this.draining = [];
    }
    return applied;
  }

  private async page(identity: RelayIdentity, account: string, ack: number | null): Promise<{ entries: { seq: number; record: unknown }[]; waiting: { key: string; at: string }[] }> {
    const call = async (path: string, body: unknown) => {
      const response = await (this.options.fetch ?? fetch)(new Request(String(this.options.service) + path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      }));
      if (!response.ok) throw new Error(`The account service answered ${response.status} to ${path}`);
      return await response.json() as Record<string, unknown>;
    };
    const publicKey = bytesToHex(importPublicKey(identity.public_key));
    const challenge = await call("/v1/pc/challenge", { server_id: identity.server_id, public_key: publicKey });
    if (typeof challenge.challenge_id !== "string") throw new Error("The account service sent no challenge");
    const proof = answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key),
      { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id });
    if (!proof) throw new Error("The account service sent a malformed challenge");
    const mailbox = await call("/v1/pc/mailbox", { server_id: identity.server_id, challenge_id: challenge.challenge_id, proof, account, ack });
    const records = mailbox.records;
    if (!Array.isArray(records) || !records.every((entry) => typeof entry === "object" && entry !== null && Number.isSafeInteger((entry as { seq?: unknown }).seq))) {
      throw new Error("The account service sent a malformed mailbox");
    }
    const admissions = Array.isArray(mailbox.admissions) ? mailbox.admissions : [];
    const waiting = admissions.filter((a): a is { key: string; at: string } => typeof a === "object" && a !== null
      && isAccountKey((a as { key?: unknown }).key) && typeof (a as { at?: unknown }).at === "string" && !Number.isNaN(Date.parse((a as { at: string }).at)));
    return { entries: records as { seq: number; record: unknown }[], waiting };
  }
}
