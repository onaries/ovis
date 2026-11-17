import type { RelayOffer } from "./relay-offer.ts";

export class ServerIdentityChangedError extends Error {
  readonly code = "server_identity_changed";
  constructor(readonly serverId: string, readonly saved?: string, readonly offered?: string) {
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
  readonly pending_key?: { readonly private_key: CryptoKey; readonly public_spki: string };
  readonly account?: string;
  readonly introduced_at?: number;
  readonly direct?: readonly string[];
}

export interface RelayDeviceStore {
  get(serverId: string): Promise<RelayDevice | undefined>;
  update(serverId: string, change: (current: RelayDevice | undefined) => RelayDevice): Promise<RelayDevice>;
  list(): Promise<RelayDevice[]>;
  remove(serverId: string): Promise<void>;
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function checkPin(device: RelayDevice, offer: RelayOffer): RelayDevice {
  if (device.server_public_key !== offer.server_public_key) throw new ServerIdentityChangedError(offer.server_id, device.server_public_key, offer.server_public_key);
  return device;
}

export async function getDevice(offer: RelayOffer, store: RelayDeviceStore, label = "Device", accountKey?: { readonly private_key: CryptoKey; readonly public_spki: string }): Promise<RelayDevice> {
  const stored = await store.get(offer.server_id);
  if (stored) return checkPin(stored, offer);
  const key = accountKey ?? await (async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    return { private_key: keys.privateKey, public_spki: base64url(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey))) };
  })();
  return {
    server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay,
    ...(offer.name === undefined ? {} : { name: offer.name }),
    device_id: null, private_key: key.private_key, public_spki: key.public_spki, label,
  };
}

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
