/** Probe results never imply account or version state. */
import { checkPc, sweepOf } from "./pcStatus.ts";
import type { PcStatus } from "./pcStatus.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import type { RelaySocket } from "./channel.ts";
import { OFFLINE_AFTER_MS } from "../account/myPcs.ts";

const CHECK_PCS = 8;
const CHECK_AT_ONCE = 2;
/** a minute: one sweep's CHECK_PCS connections (up to two each, with the global relay's fallback) stay well under the relay's 30 a minute */
const CHECK_GAP_MS = 60_000;
const CHECK_KEY = "ovis-pc-check-at";
const CHECK_CURSOR_KEY = "ovis-pc-check-cursor";

function localStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch {}
}

interface QueuedCheck { readonly device: RelayDevice; readonly settled: ReturnType<typeof Promise.withResolvers<void>> }

export function createPcSweep(store: RelayDeviceStore, view: { readonly active: () => boolean; readonly redraw: () => void }, options: { readonly probe?: typeof checkPc; readonly directSocket?: (url: string) => RelaySocket } = {}) {
  const pcStatus = new Map<string, PcStatus>();
  const probe = options.probe ?? checkPc;
  const directSocket = options.directSocket;
  const sockets = { relay: (url: string) => new WebSocket(url), ...(directSocket ? { direct: directSocket } : {}) };
  let lastCheck = -Infinity;
  let deferred: ReturnType<typeof setTimeout> | undefined;
  let sweeping: Promise<void> | undefined;
  const queue: QueuedCheck[] = [];
  let workers = 0;
  const redraw = (): void => { if (view.active()) view.redraw(); };
  const cursorNow = (): number => Number(localStorageGet(CHECK_CURSOR_KEY) ?? "0");

  const enqueue = (device: RelayDevice, where: "front" | "back"): Promise<void> => {
    const entry: QueuedCheck = { device, settled: Promise.withResolvers<void>() };
    if (where === "front") queue.unshift(entry); else queue.push(entry);
    return entry.settled.promise;
  };
  const probeNext = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const found = await probe(next.device, sockets).catch((): PcStatus => ({ kind: "offline", reason: "relay" }));
      const serverId = next.device.server_id;
      pcStatus.set(serverId, found);
      if (found.kind === "answered") setTimeout(() => { if (pcStatus.get(serverId) === found) { pcStatus.delete(serverId); redraw(); } }, OFFLINE_AFTER_MS);
      redraw();
      next.settled.resolve();
    }
  };
  const drain = (): void => {
    for (let spare = Math.min(CHECK_AT_ONCE - workers, queue.length); spare > 0; spare -= 1) {
      workers += 1;
      void probeNext().finally(() => { workers -= 1; });
    }
  };

  const checkPcs = async (): Promise<void> => {
    if (sweeping) return;
    const stored = Number(localStorageGet(CHECK_KEY) ?? "");
    const wait = CHECK_GAP_MS - (Date.now() - Math.max(lastCheck, Number.isFinite(stored) ? stored : -Infinity));
    if (wait > 0) {
      deferred ??= setTimeout(() => { deferred = undefined; if (view.active()) void checkPcs(); }, wait);
      redraw();
      return;
    }
    lastCheck = Date.now();
    localStorageSet(CHECK_KEY, String(lastCheck));
    sweeping = sweepPcs().finally(() => { sweeping = undefined; });
    await sweeping;
  };
  const sweepPcs = async (): Promise<void> => {
    const cursor = cursorNow();
    const saved = sweepOf(await store.list(), cursor, CHECK_PCS).filter((device) => pcStatus.get(device.server_id)?.kind !== "checking");
    localStorageSet(CHECK_CURSOR_KEY, String(cursor + CHECK_PCS));
    for (const device of saved) pcStatus.set(device.server_id, { kind: "checking" });
    redraw();
    const settled = saved.map((device) => enqueue(device, "back"));
    drain();
    await Promise.all(settled);
  };
  const checkOne = async (serverId: string): Promise<void> => {
    const waiting = queue.findIndex((entry) => entry.device.server_id === serverId);
    if (waiting >= 0) {
      const [entry] = queue.splice(waiting, 1);
      if (entry) { queue.unshift(entry); return entry.settled.promise; }
    }
    if (pcStatus.get(serverId)?.kind === "checking") return;
    const device = await store.get(serverId);
    if (device === undefined) return;
    pcStatus.set(serverId, { kind: "checking" });
    redraw();
    const settled = enqueue(device, "front");
    drain();
    await settled;
  };

  return { status: pcStatus, check: checkPcs, checkOne };
}
