import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { PendingPush, PendingPushStore } from "../push.ts";

export class ServerIdentityChangedError extends Error {
  readonly code = "server_identity_changed";
  constructor(readonly serverId: string) {
    super("This PC's identity changed");
    this.name = "ServerIdentityChangedError";
  }
}

export interface RelayDevice {
  readonly server_id: string;
  readonly device_id: string | null;
  readonly private_key: CryptoKey;
  readonly public_spki: string;
  readonly label: string;
  readonly server_public_key: string;
  readonly relay: string;
  readonly name?: string;
}

/** Updates are atomic, including between two tabs the same PC admits at once. */
export interface RelayDeviceStore {
  get(serverId: string): Promise<RelayDevice | undefined>;
  update(serverId: string, change: (current: RelayDevice | undefined) => RelayDevice): Promise<RelayDevice>;
  /** Every saved PC, in the order they were first saved. */
  list(): Promise<RelayDevice[]>;
  /** Forgets a PC: its key is gone for good, and the PC's next pairing makes a new one; a push subscription kept for it goes too. */
  remove(serverId: string): Promise<void>;
}

export const indexedDeviceStore: RelayDeviceStore = {
  async get(serverId) {
    const db = await openDatabase();
    try {
      return await new Promise<RelayDevice | undefined>((resolve, reject) => {
        const tx = db.transaction("devices", "readonly");
        const request: IDBRequest<RelayDevice | undefined> = tx.objectStore("devices").get(serverId);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async list() {
    const db = await openDatabase();
    try {
      return await new Promise<RelayDevice[]>((resolve, reject) => {
        const tx = db.transaction("devices", "readonly");
        const request: IDBRequest<RelayDevice[]> = tx.objectStore("devices").getAll();
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async remove(serverId) {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["devices", "pending-push"], "readwrite");
        tx.objectStore("devices").delete(serverId);
        tx.objectStore("pending-push").delete(serverId);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async update(serverId, change) {
    const db = await openDatabase();
    try {
      return await new Promise<RelayDevice>((resolve, reject) => {
        const tx = db.transaction("devices", "readwrite");
        const store = tx.objectStore("devices");
        const request: IDBRequest<RelayDevice | undefined> = store.get(serverId);
        let result: RelayDevice;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
        request.onsuccess = () => {
          try {
            result = change(request.result);
            store.put(result);
          } catch (error) {
            tx.abort();
            reject(error);
          }
        };
      });
    } finally { db.close(); }
  },
};

/** The subscriptions each PC's worker kept for the shell to register (lib/push.ts registerPendingPush). */
export const indexedPendingPush: PendingPushStore = {
  async get(serverId) {
    const db = await openDatabase();
    try {
      return await new Promise<PendingPush | undefined>((resolve, reject) => {
        const tx = db.transaction("pending-push", "readonly");
        const request: IDBRequest<PendingPush | undefined> = tx.objectStore("pending-push").get(serverId);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async clear(serverId, endpoint) {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("pending-push", "readwrite");
        const store = tx.objectStore("pending-push");
        const request: IDBRequest<PendingPush | undefined> = store.get(serverId);
        request.onsuccess = () => { if (request.result?.subscription.endpoint === endpoint) store.delete(serverId); };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
};

/**
 * The shell's database. Version 2 added `pending-push`, which the worker writes too: public/sw.js
 * openRelayDatabase opens the same name and version with the same stores.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ovis-relay", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("devices")) db.createObjectStore("devices", { keyPath: "server_id" });
      if (!db.objectStoreNames.contains("pending-push")) db.createObjectStore("pending-push", { keyPath: "server_id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function checkPin(device: RelayDevice, offer: RelayOffer): RelayDevice {
  if (device.server_public_key !== offer.server_public_key) throw new ServerIdentityChangedError(offer.server_id);
  return device;
}

/**
 * The saved key for the offer's PC, or a new one that is not saved yet: a new key is kept only once
 * the PC admits it (channel.ts), so a link whose PC never does takes no PC's slot.
 */
export async function getDevice(offer: RelayOffer, store: RelayDeviceStore = indexedDeviceStore, label = "Device"): Promise<RelayDevice> {
  const stored = await store.get(offer.server_id);
  if (stored) return checkPin(stored, offer);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return {
    server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay,
    ...(offer.name === undefined ? {} : { name: offer.name }),
    device_id: null, private_key: keys.privateKey,
    public_spki: base64url(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey))), label,
  };
}

/** Raw r||s ECDSA signature; the server verifies this exact domain, nonce and server id. */
export async function sign(device: RelayDevice, nonce: Uint8Array, serverId: string): Promise<string> {
  if (nonce.length !== 32 || serverId !== device.server_id) throw new TypeError("Invalid relay authentication challenge");
  const encoder = new TextEncoder();
  const domain = encoder.encode("ovis-relay-auth/1");
  const id = encoder.encode(serverId);
  const message = new Uint8Array(domain.length + nonce.length + id.length);
  message.set(domain);
  message.set(nonce, domain.length);
  message.set(id, domain.length + nonce.length);
  return base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.private_key, message)));
}
