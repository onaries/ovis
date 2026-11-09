import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CLIProxyStatus, ProviderUsage } from "../shared/protocol.ts";
import { isJsonObject } from "./http.ts";
import { writePrivateState } from "./private-state.ts";
import { FRESH_MS, MIN_REFRESH_MS, systemUsageContext, USAGE_PROVIDERS, UsageHttpError } from "./usage.ts";

export class CLIProxyError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export const proxyInvalid = () => new CLIProxyError("invalid_cliproxy_request", 400, "Invalid Hub request");
/**
 * Which account a Hub file is, whatever its file name: its provider and the account it names (email, ChatGPT
 * workspace: `holder`), and its auth index, either of which tells it (#3428: an email may change while the index
 * stays). Never reported.
 */
const accountIdentities = (provider: string, holder: string | null, index: string): readonly string[] =>
  [...(holder === null ? [] : [JSON.stringify([provider, holder])]), `index:${provider}:${index}`];
const isIndexed = (identity: string) => identity.startsWith("index:");
const sameAccount = (known: readonly string[], identities: readonly string[]) => known.some((identity) => identities.includes(identity));
const isHubKey = (key: string) => key.includes(":cliproxy:");
/** why no Hub account is read while blind (CLIProxyService.blind): shown where Settings shows the Hub's state */
const BLIND_PROBLEM = "Hidden accounts could not be told apart, so no hub account is read. Show again each hidden hub account, or save the hub again to read them by file name.";
/** a saved hidden list larger than this is no list this server wrote */
const HIDDEN_MAX_BYTES = 64 * 1024;

/** The saved hidden list's text: a regular file of this user's, no link, at most HIDDEN_MAX_BYTES; throws otherwise. */
function readOwnFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > HIDDEN_MAX_BYTES || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error("not this server's file");
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > HIDDEN_MAX_BYTES) throw new Error("not this server's file");
    return text;
  } finally { closeSync(fd); }
}
type Config = { readonly url: string; readonly management_key: string };
const DEFAULT_URL = "http://localhost:8317";

/** Only fixed messages cross this boundary; upstream errors can echo management credentials. */
export class CLIProxyService {
  private config: Config | null = null;
  private readonly path: string;
  private blocked: CLIProxyError | null = null;
  private problem: string | null = null;
  private checked = false;
  private nextAt = 0;
  private readAt = 0;
  private entries: readonly ProviderUsage[] = [];
  private pending: Promise<readonly ProviderUsage[]> | null = null;
  private generation = 0;
  private requests: Promise<void> = Promise.resolve();
  /** the hidden or removed accounts of the last report: their credentials are not used (#3333) */
  private skipped: ReadonlySet<string> = new Set();
  /** the accounts hidden or removed from Ovis now (UsageService.skipAccounts): hiding one starts no report */
  private hidden: () => ReadonlySet<string> = () => this.skipped;
  /** when each account shown again was read on its own, so the next full read does not read it again within MIN_REFRESH_MS */
  private readonly shownAt = new Map<string, number>();
  /** the account (email, ChatGPT workspace) each row's file named when it was read; never reported */
  private readonly holders = new WeakMap<ProviderUsage, string>();
  /** the account each row is (accountIdentities); never reported */
  private readonly identities = new WeakMap<ProviderUsage, readonly string[]>();
  /** the rows read or listed while their key was not hidden: only these tell which account a key was when it was hidden */
  private readonly shownRows = new WeakSet<ProviderUsage>();
  /**
   * The account each hidden key was when it was hidden, by identity, learned only from a row shown then (#3423): that
   * account is not read under any file name, and another one under the key's file name is. A key hidden before any row
   * of it was shown (a fresh server) has none, and its file name alone keeps whoever is under it unread. Kept only
   * while the key is hidden, so bounded by the hidden list.
   */
  private readonly hiddenAccounts = new Map<string, readonly string[]>();
  /** where hiddenAccounts is saved, with the Hub it was learned on, so a restart keeps a moved hidden account unread (#3427) */
  private readonly hiddenPath: string;
  /** the document last written to (or read from) hiddenPath; null: none there yet, or the last save failed */
  private savedHidden: string | null = null;
  /** the hidden Hub keys the saved list covers, with or without a known account; null: no list was found at start */
  private covered: Set<string> | null = null;
  /** whether the first sync after start has checked the hidden Hub keys against the saved list */
  private checkedCovered = false;
  /**
   * Fail closed (#3428): set when the saved list cannot be trusted (unreadable, not the list, a link, not this user's,
   * too large) or does not cover a key hidden before this start (its save never landed). A hidden Hub key with no
   * known account may then be any account under any file name, so while one is hidden, or while the hidden list is
   * read only in part (a key left out may be one), no Hub account is read at all. Ways out, each saved: the whole
   * hidden list holds no such key, because each was shown again or names a file the Hub lists (that file's account is
   * then taken as the one hidden, as a fresh server takes it by file name); or the user saves the Hub again, told why
   * by status().problem, which keeps the hidden keys unread by file name alone.
   */
  private blind = false;
  /** the last save of the hidden list failed: the next change of the preferences tries again, and fails while it does */
  private hiddenSaveFailed = false;
  private hiddenWhole: () => boolean = () => true;

  constructor(stateDir: string) {
    this.path = join(stateDir, "cliproxy.json");
    this.hiddenPath = join(stateDir, "cliproxy-hidden.json");
    // with no Hub configured too: a removed Hub's accounts known by their email stay known for the next one
    this.load();
    this.loadHidden();
  }

  private load(): void {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (isJsonObject(value) && Object.keys(value).length === 0) { this.config = null; return; }
      if (!isJsonObject(value) || typeof value["url"] !== "string" || typeof value["management_key"] !== "string") throw proxyInvalid();
      this.config = { url: this.base(value["url"]), management_key: value["management_key"] };
    } catch (error) {
      this.config = null;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.problem = "Could not read Hub configuration";
        console.warn(`cliproxy: ${this.problem}`);
      }
    }
  }

  private base(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch { throw proxyInvalid(); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw proxyInvalid();
    return url.href.replace(/\/+$/, "").replace(/\/v8\/management$/, "");
  }

  status(): CLIProxyStatus {
    const problem = this.problem ?? (this.config !== null && this.blindTo(this.hidden()) ? BLIND_PROBLEM : null);
    return { configured: this.config !== null, url: this.config?.url ?? DEFAULT_URL, ok: this.checked && problem === null, problem };
  }

  async save(value: unknown): Promise<CLIProxyStatus> {
    if (!isJsonObject(value) || typeof value["url"] !== "string" || value["url"].length > 2000) throw proxyInvalid();
    const url = this.base(value["url"]);
    const supplied = value["management_key"];
    if (supplied !== undefined && (typeof supplied !== "string" || !supplied.trim())) throw proxyInvalid();
    const suppliedKey = typeof supplied === "string" ? supplied.trim() : null;
    const key = suppliedKey ?? this.config?.management_key;
    if (!key || key.length > 2000 || /\s/.test(key) || url.includes(key) || (this.config && url !== this.config.url && !suppliedKey)) throw proxyInvalid();
    this.persist({ url, management_key: key });
    // saving the Hub again is the user's way out of blind (status().problem says so): hidden keys stay unread by file name.
    // Not while the hidden list is read only in part (a key left out has no file name to keep unread), and not unsaved:
    // a restart would find the list still blind, so the save says it failed and blind holds here too
    if (this.blind && this.hiddenWhole()) {
      this.blind = false;
      if (!this.saveHidden()) {
        this.blind = true;
        throw new CLIProxyError("cliproxy_hidden_unsaved", 500, "Could not save which Hub accounts are hidden");
      }
    }
    return this.check();
  }

  async check(): Promise<CLIProxyStatus> {
    if (!this.config || this.checked) return this.status();
    const generation = this.generation;
    let problem: string | null = null;
    try {
      const body = await this.call("/credentials");
      if (!Array.isArray(body["files"])) throw new CLIProxyError("cliproxy_response", 502, "Hub returned an unreadable response");
    } catch (error) {
      if (!(error instanceof CLIProxyError)) throw error;
      problem = error.message;
    }
    if (generation === this.generation) { this.problem = problem; this.checked = true; }
    return this.status();
  }

  remove(): CLIProxyStatus {
    this.persist(null);
    return this.status();
  }

  private persist(config: Config | null): void {
    // an exclusive temporary file of a name no one can guess: nothing left in its place receives the key (#3428)
    writePrivateState(this.path, config ?? {});
    // another Hub, or another key to it, has other accounts: no row of the old one stays, hidden or not
    const moved = config?.url !== this.config?.url || config?.management_key !== this.config?.management_key;
    this.config = config;
    this.blocked = null;
    this.problem = null;
    this.checked = false;
    this.invalidate();
    // an account known by its email is that account on any Hub; one known only by its auth index is so on its own Hub alone
    if (moved) { this.entries = []; this.forgetIndexed(); this.saveHidden(); }
  }

  /** Drops what an auth index says of the hidden accounts: it names a file on one Hub alone. */
  private forgetIndexed(): void {
    for (const [key, identities] of this.hiddenAccounts) {
      const kept = identities.filter((identity) => !isIndexed(identity));
      if (kept.length === 0) this.hiddenAccounts.delete(key);
      else this.hiddenAccounts.set(key, kept);
    }
  }

  /** The Hub a saved hiddenAccounts belongs to: its address and management key, digested, so the key is never written there. */
  private hub(): string | null {
    return this.config === null ? null : createHash("sha256").update(`${this.config.url}\0${this.config.management_key}`).digest("hex");
  }

  /**
   * hiddenAccounts as saved; from another Hub, only the accounts known by their email. None saved yet (a fresh
   * server): no hidden account's identity is known, and a hidden key's file name alone keeps it unread. A list that
   * is there but cannot be trusted fails closed (blind).
   */
  private loadHidden(): void {
    let text: string;
    try { text = readOwnFile(this.hiddenPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.blind = true;
      console.warn("cliproxy: the saved hidden accounts cannot be read; no Hub account is read while a hidden one is unknown");
      return;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = null; }
    const accounts = isJsonObject(value) ? value["accounts"] : null;
    const keys = isJsonObject(value) ? value["keys"] : null;
    const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");
    if (!isJsonObject(value) || !isJsonObject(accounts) || !strings(keys) || typeof value["blind"] !== "boolean"
      || !Object.values(accounts).every((identities) => strings(identities) && identities.length > 0)) {
      this.blind = true;
      console.warn("cliproxy: the saved hidden accounts are not a list; no Hub account is read while a hidden one is unknown");
      return;
    }
    for (const [key, identities] of Object.entries(accounts)) this.hiddenAccounts.set(key, identities as string[]);
    this.covered = new Set(keys);
    this.blind = value["blind"];
    if (value["hub"] !== this.hub()) this.forgetIndexed();
    this.savedHidden = this.hiddenDocument();
  }

  private hiddenDocument(): string {
    return JSON.stringify({ hub: this.hub(), accounts: Object.fromEntries(this.hiddenAccounts), keys: [...this.covered ?? []], blind: this.blind });
  }

  /** Saves the hidden list when it changed; a failed save is tried again at the next sync. false: not saved. */
  private saveHidden(): boolean {
    const document = this.hiddenDocument();
    if (document === this.savedHidden) return true;
    try {
      writePrivateState(this.hiddenPath, JSON.parse(document));
      this.savedHidden = document;
      this.hiddenSaveFailed = false;
      return true;
    } catch {
      this.hiddenSaveFailed = true;
      console.warn("cliproxy: could not save which accounts are hidden");
      return false;
    }
  }

  /** while blind, a hidden Hub key with no known account, or one a list read in part left out, may be any account: no Hub account is read */
  private blindTo(hidden: ReadonlySet<string>): boolean {
    return this.blind && (!this.hiddenWhole() || [...hidden].some((key) => isHubKey(key) && !this.hiddenAccounts.has(key)));
  }

  /** whether the last save of the hidden list failed, so a change of the preferences must try it again */
  hiddenUnsaved(): boolean { return this.hiddenSaveFailed; }

  /**
   * Learns which account each key newly in `hidden` is, from a row shown before it was hidden, forgets the keys no longer
   * in it, and saves the result: at every report, and as soon as the hidden list changes (hiddenChanged), since hiding
   * an account starts no report and a restart before one must still know it.
   */
  private syncHidden(hidden: ReadonlySet<string>): boolean {
    for (const row of this.entries) {
      const identities = this.identities.get(row);
      // while blind, a hidden key naming a file the Hub lists is taken to be that file's account (listed, never read)
      if (identities !== undefined && (this.shownRows.has(row) || this.blind) && hidden.has(row.key) && !this.hiddenAccounts.has(row.key)) this.hiddenAccounts.set(row.key, identities);
    }
    const whole = this.hiddenWhole();
    // a key missing from a list read only in part may still be hidden: it is forgotten only once the whole list says so
    if (whole) for (const key of this.hiddenAccounts.keys()) if (!hidden.has(key)) this.hiddenAccounts.delete(key);
    const hub = [...hidden].filter(isHubKey);
    // a Hub key hidden before this start that the saved list neither covers nor knows was hidden by a save that never landed
    if (!this.checkedCovered && this.covered !== null && hub.some((key) => !this.covered?.has(key) && !this.hiddenAccounts.has(key))) this.blind = true;
    this.checkedCovered = true;
    if (this.blind && whole && hub.every((key) => this.hiddenAccounts.has(key))) this.blind = false;
    this.covered = new Set([...(whole ? [] : (this.covered ?? [])), ...hub]);
    return this.saveHidden();
  }

  /**
   * The hidden or removed accounts changed (Settings, or the removed list): remember or forget which accounts they are
   * now. Throws when that cannot be saved, so the change is not taken as done: the account stays unread here, and a
   * restart that finds the older list reads no Hub account while it is hidden (#3428).
   */
  hiddenChanged(): void {
    if (!this.syncHidden(this.hidden())) throw new Error("Could not save which Hub accounts are hidden");
  }

  /** `whole`: whether `keys` read the hidden list entire; while not (the removed list unreadable), no hidden account is forgotten */
  skipAccounts(keys: () => ReadonlySet<string>, whole: () => boolean = () => true): void { this.hidden = keys; this.hiddenWhole = whole; }

  /** The next report reads the Hub anew, except the rows of the hidden or removed accounts: their credentials stay unused (#3333). */
  invalidate(): void {
    this.generation++; this.nextAt = 0; this.readAt = 0; this.pending = null; this.shownAt.clear();
    const hidden = this.hidden();
    this.entries = this.entries.filter((entry) => hidden.has(entry.key));
  }

  call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    // A revoked key must cause one refusal, not one per account (the proxy bans after five).
    const request = this.requests.then(() => this.request(path, init));
    this.requests = request.then(() => undefined, () => undefined);
    return request;
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    if (this.blocked) throw this.blocked;
    const config = this.config;
    if (!config) throw new CLIProxyError("cliproxy_not_configured", 409, "Configure Hub first");
    try {
      const response = await fetch(`${config.url}/v8/management${path}`, {
        ...init, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "content-type": "application/json", authorization: `Bearer ${config.management_key}` },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const auth = response.status === 401 || response.status === 403;
        const error = new CLIProxyError(auth ? "cliproxy_auth" : "cliproxy_upstream", 502,
          auth ? "Hub rejected the key. Save a valid key." : "Hub could not complete the request");
        if (auth && config === this.config) this.blocked = error;
        throw error;
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024 * 1024) { await reader.cancel(); throw new CLIProxyError("cliproxy_response", 502, "Hub returned an unreadable response"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const value: unknown = JSON.parse(raw.split(JSON.stringify(config.management_key).slice(1, -1)).join("[redacted]"));
      if (!isJsonObject(value)) throw new CLIProxyError("cliproxy_response", 502, "Hub returned an unreadable response");
      return value;
    } catch (error) {
      const safe = error instanceof CLIProxyError ? error : new CLIProxyError("cliproxy_unreachable", 502, "Could not reach Hub");
      if (config === this.config) { this.problem = safe.message; this.checked = true; }
      throw safe;
    }
  }

  /** `skipped`: accounts hidden or removed from Ovis, whose last rows stay without asking the Hub to use their credentials; one shown again is read now, alone. */
  report(refresh = false, skipped: ReadonlySet<string> = new Set()): Promise<readonly ProviderUsage[]> {
    if (!this.config) return Promise.resolve([]);
    if (this.pending) return this.pending;
    const now = Date.now();
    const due = now >= this.nextAt || (refresh && now - this.readAt >= MIN_REFRESH_MS);
    const shown = this.entries.filter((entry) => this.skipped.has(entry.key) && !skipped.has(entry.key)).map((entry) => entry.key);
    this.skipped = skipped;
    // hidden by this report's snapshot or since (the live list): never read, whatever rows are kept (#3423)
    const hiddenNow = new Set([...skipped, ...this.hidden()]);
    // which account a hidden key is follows the live list alone: a report's older snapshot must not bring back a key shown since
    this.syncHidden(this.hidden());
    if (!due && shown.length === 0) return Promise.resolve(this.entries);
    // before their time only the accounts shown again are read: every other row is still fresh and stays
    // and a full read leaves out an account shown again and read less than MIN_REFRESH_MS ago
    const kept = due
      ? new Set([...skipped, ...[...this.shownAt].filter(([, at]) => now - at < MIN_REFRESH_MS).map(([key]) => key)])
      : new Set(this.entries.map((entry) => entry.key).filter((key) => !shown.includes(key)));
    const generation = this.generation;
    const pass = this.collect(kept, hiddenNow).then((entries) => {
      if (generation !== this.generation) return [];
      // a partial read that failed changes nothing: the cached rows, hidden ones included, stay, and the
      // accounts shown again count as just shown at the next report, so it reads them again
      if (!due && entries === null) { this.skipped = new Set([...this.skipped, ...shown]); return this.entries; }
      // a full read that failed keeps the hidden accounts' rows, so they stay unread, and the next report reads again;
      // hidden by this report's snapshot or since (the live list), as invalidate keeps them
      if (entries === null) {
        const hidden = this.hidden();
        this.entries = this.entries.filter((entry) => skipped.has(entry.key) || hidden.has(entry.key));
        return this.entries;
      }
      this.entries = entries;
      if (due) { this.readAt = now; this.nextAt = now + FRESH_MS; this.shownAt.clear(); }
      else for (const key of shown) this.shownAt.set(key, now);
      return this.entries;
    }).finally(() => { if (this.pending === pass) this.pending = null; });
    this.pending = pass;
    return pass;
  }

  /**
   * `kept`: the accounts whose last rows stay unread (while their file still names the same account); `hidden`: the
   * accounts the hidden list names, asked by key before any api-call, never by whether a row of them is kept. null:
   * the Hub could not be read
   */
  private async collect(kept: ReadonlySet<string>, hidden: ReadonlySet<string>): Promise<readonly ProviderUsage[] | null> {
    try {
      const body = await this.call("/credentials");
      if (!Array.isArray(body["files"])) throw new CLIProxyError("cliproxy_response", 502, "Hub returned an unreadable response");
      const files = body["files"].filter(isJsonObject);
      this.problem = null; this.checked = true;
      const ctx = systemUsageContext();
      const blind = this.blindTo(hidden);
      return await Promise.all(files.flatMap((file) => {
        const provider = USAGE_PROVIDERS.find((item) => (item.id === "claude" || item.id === "codex") && item.id === file["provider"]);
        const index = file["auth_index"];
        if (!provider || typeof index !== "string" || !index) return [];
        const name = typeof file["name"] === "string" ? file["name"] : index;
        const account = typeof file["email"] === "string" ? file["email"] : name;
        const claims = file["id_token"];
        const workspace = isJsonObject(claims) && typeof claims["chatgpt_account_id"] === "string" ? claims["chatgpt_account_id"] : null;
        const entry: ProviderUsage = { id: provider.id, key: `${provider.id}:cliproxy:${encodeURIComponent(name)}`, account, plan: null, windows: [], problem: "failed", checked_at: null };
        // a hidden or removed account keeps its last row; one never read yet is read once, so it can be listed
        // only while the file still names that account: another one under the same name is read anew
        // a file naming neither is no known account: no row is kept on it, it is read again
        const email = typeof file["email"] === "string" ? file["email"] : null;
        const holder = email === null && workspace === null ? null : JSON.stringify([email, workspace]);
        const last = kept.has(entry.key) && holder !== null ? this.entries.find((held) => held.key === entry.key && this.holders.get(held) === holder) : undefined;
        if (last) return [Promise.resolve(last)];
        const identities = accountIdentities(provider.id, holder, index);
        const held = (row: ProviderUsage): ProviderUsage => {
          if (holder !== null) this.holders.set(row, holder);
          this.identities.set(row, identities);
          if (!hidden.has(row.key)) this.shownRows.add(row);
          return row;
        };
        // hidden is decided by account, the file name only a hint (#3423): an account hidden under any key is listed unread
        // under whatever name it has now, and its credentials are not used; under a hidden key's name, only an account
        // known to be another than the one hidden is read anew
        const hiddenAs = [...this.hiddenAccounts].some(([key, known]) => hidden.has(key) && sameAccount(known, identities));
        const named = this.hiddenAccounts.get(entry.key);
        if (blind || hiddenAs || (hidden.has(entry.key) && (named === undefined || sameAccount(named, identities)))) return [Promise.resolve(held({ ...entry, problem: null }))];
        if (file["disabled"] === true || file["unavailable"] === true) return [Promise.resolve(held(entry))];
        return [(async (): Promise<ProviderUsage> => {
          try {
            const reading = await provider.read({ ...ctx, fetch: async (url, init) => {
              const header = Object.fromEntries(new Headers(init.headers).entries());
              header["authorization"] = "Bearer $TOKEN$";
              const answer = await this.call("/requests/api-call", { method: "POST", body: JSON.stringify({ auth_index: index, method: "GET", url, header }) });
              const status = answer["status_code"];
              if (typeof status !== "number" || status < 200 || status > 599 || typeof answer["body"] !== "string") throw proxyInvalid();
              return new Response(answer["body"], { status });
            } }, { token: "$TOKEN$", expiresAt: null, chatgptAccount: workspace });
            return reading ? { ...entry, plan: reading.plan, windows: reading.windows, problem: null, checked_at: new Date().toISOString() } : entry;
          } catch (error) {
            return { ...entry, problem: error instanceof UsageHttpError && (error.status === 401 || error.status === 403) ? "expired" : "failed" };
          }
        })().then(held)];
      }));
    } catch (error) {
      if (!(error instanceof CLIProxyError)) throw error;
      this.problem = error.message; this.checked = true;
      return null;
    }
  }
}
