/**
 * This client's account state (docs/account.md, rule 2): its one account key, made by WebCrypto as
 * non-extractable, its sign-in with the account service, and a sign-in on its way through the
 * provider's pages. In an IndexedDB database of its own, `ovis-account`: the shell's `ovis-relay`
 * (relay/device.ts) is shared with the service worker at a fixed version, and the worker never
 * opens this one.
 */
import { exportAccountKey } from "../../../shared/account-records.ts";
import type { AddRecord, RemoveRecord } from "../../../shared/account-records.ts";

export interface AccountKey {
  readonly private_key: CryptoKey;
  /** P-256 SPKI, base64url: the device's `relay_public_key` on every PC of the account */
  readonly public_spki: string;
}

export const ACCOUNT_PROVIDERS = ["github", "apple"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export interface AccountSession {
  /** the account service's origin this sign-in is with */
  readonly service: string;
  readonly account: string;
  readonly provider: AccountProvider;
  readonly access_token: string;
  readonly refresh_token: string;
  /** when the access token runs out, in ms since the epoch */
  readonly expires_at: number;
}

/** A sign-in sent to the provider's pages: what its return must match (OAuth `state`) and prove (PKCE verifier). */
export interface PendingSignIn {
  readonly service: string;
  readonly provider: AccountProvider;
  readonly state: string;
  readonly verifier: string;
  readonly redirect_uri: string;
  readonly started_at: number;
}

interface Records {
  key: AccountKey;
  session: AccountSession;
  /** by `state`, so a return consumes only its own sign-in and two tabs can each have one */
  pending: Readonly<Record<string, PendingSignIn>>;
  /** by record id: an `add` this device signed that some PCs' mailboxes have not taken yet (account/join.ts) */
  adds: Readonly<Record<string, QueuedAdd>>;
  /**
   * By key: the latest record this device signed for a device of the account, an `add` for one it
   * approved itself (docs/account.md, rule 6) or a `remove` for one it removed: what it hands a PC it
   * brings into the account (account/join.ts, enrollPc)
   */
  devices: Readonly<Record<string, AddRecord | RemoveRecord>>;
  /**
   * By record id: other members' signed `remove`s that a PC of the account listed and this device
   * checked (account/join.ts, keepRemovals), kept verbatim to relay to a PC it brings into the account
   */
  removals: Readonly<Record<string, RemoveRecord>>;
  /** by server_id: a PC this device brought into the account, and the records whose outcome it read there */
  enrolls: Readonly<Record<string, PlannedEnroll>>;
}

export interface PlannedEnroll {
  readonly account: string;
  /** ids of the records the PC answered with a final outcome */
  readonly done: readonly string[];
}

export interface QueuedAdd {
  readonly account: string;
  readonly record: AddRecord;
  /** the PCs whose mailbox it has not reached */
  readonly to: readonly string[];
}
type Name = keyof Records;
type Many<N extends Exclude<Name, "key">> = { [K in N]?: Records[K] };

/** Each read and write is one transaction; `key` is made at most once, between tabs too. */
export interface AccountStore {
  key(): Promise<AccountKey>;
  get<N extends Exclude<Name, "key">>(name: N): Promise<Records[N] | undefined>;
  set<N extends Exclude<Name, "key">>(name: N, value: Records[N] | undefined): Promise<void>;
  /** Reads and writes `name` in one transaction; `change` runs synchronously inside it. */
  update<N extends Exclude<Name, "key">>(name: N, change: (current: Records[N] | undefined) => Records[N] | undefined): Promise<void>;
  /** Reads and writes several `names` in one transaction; a name `change` leaves out, or sets undefined, is deleted. */
  updateMany<N extends Exclude<Name, "key">>(names: readonly N[], change: (current: Many<N>) => Many<N>): Promise<void>;
  /** Forgets the key and the sign-in: a new key is made on next use, which no PC knows. */
  clear(): Promise<void>;
}

async function newKey(): Promise<AccountKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { private_key: pair.privateKey, public_spki: await exportAccountKey(pair.publicKey) };
}

export function memoryAccountStore(): AccountStore {
  const records = new Map<Name, Records[Name]>();
  let making: Promise<AccountKey> | null = null;
  return {
    key() {
      const saved = records.get("key") as AccountKey | undefined;
      if (saved) return Promise.resolve(saved);
      making ??= newKey().then((key) => { records.set("key", key); making = null; return key; });
      return making;
    },
    async get(name) { return records.get(name) as never; },
    async set(name, value) { if (value === undefined) records.delete(name); else records.set(name, value); },
    async update(name, change) {
      const next = change(records.get(name) as never);
      if (next === undefined) records.delete(name); else records.set(name, next);
    },
    async updateMany(names, change) {
      const next = change(Object.fromEntries(names.map((name) => [name, records.get(name)])) as never) as Record<string, Records[Name] | undefined>;
      for (const name of names) {
        if (next[name] === undefined) records.delete(name); else records.set(name, next[name]);
      }
    },
    async clear() { records.clear(); },
  };
}

/** Runs `work` alone among this origin's tabs (Web Locks), where the browser has them. */
export type AccountLock = <T>(work: () => Promise<T>) => Promise<T>;

export const accountLock: AccountLock = (work) => {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request("ovis-account-session", work) : work();
};

/** One lock for every AccountService that shares a memory store, as tabs share the browser's. */
export function memoryLock(): AccountLock {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

const DATABASE = "ovis-account";
const STORE = "account";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result());
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export const indexedAccountStore: AccountStore = {
  async key() {
    // made outside the transaction, which would commit while WebCrypto works; another tab's key, saved first, wins
    const made = await newKey();
    return transact("readwrite", (store) => {
      const request: IDBRequest<AccountKey | undefined> = store.get("key");
      request.onsuccess = () => { if (request.result === undefined) store.put(made, "key"); };
      return () => request.result ?? made;
    });
  },
  get(name) {
    return transact("readonly", (store) => {
      const request = store.get(name);
      return () => request.result as never;
    });
  },
  set(name, value) {
    return transact("readwrite", (store) => {
      if (value === undefined) store.delete(name);
      else store.put(value, name);
      return () => undefined;
    });
  },
  update(name, change) {
    return transact("readwrite", (store) => {
      const request = store.get(name);
      request.onsuccess = () => {
        const next = change(request.result as never);
        if (next === undefined) store.delete(name);
        else store.put(next, name);
      };
      return () => undefined;
    });
  },
  updateMany(names, change) {
    return transact("readwrite", (store) => {
      const current: Record<string, unknown> = {};
      let left = names.length;
      for (const name of names) {
        const request = store.get(name);
        request.onsuccess = () => {
          current[name] = request.result;
          if (--left > 0) return;
          const next = change(current as never) as Record<string, unknown>;
          for (const each of names) {
            if (next[each] === undefined) store.delete(each);
            else store.put(next[each], each);
          }
        };
      }
      return () => undefined;
    });
  },
  clear() {
    return transact("readwrite", (store) => {
      store.clear();
      return () => undefined;
    });
  },
};
