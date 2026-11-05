/**
 * The one way this client reaches its server: every HTTP request, the terminal WebSocket, the
 * event stream and the address of a file the browser loads itself. The native transport is the
 * browser's own, read from the globals at each call, so a stand-in installed on `window` (the
 * demo's site/demo/transport.ts) still answers. Another transport is set once, at boot.
 */

/** What HerdrSocket needs of a WebSocket; the browser's own is one. */
export interface WebSocketLike {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
}

/** What the event stream needs of an EventSource; the browser's own is one. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener<K extends keyof EventSourceEventMap>(type: K, listener: (event: EventSourceEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  close(): void;
}

export interface Transport {
  readonly kind: "native" | "relay";
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  openSocket(url: string): WebSocketLike;
  openEventSource(url: string): EventSourceLike;
  /** The address the browser loads a server path from (an <img>, a <video>, a download link). */
  resourceUrl(path: string, signal?: AbortSignal): string | Promise<string>;
}

/** Reads in flight on the browser's own connections: the abort abandonNativeReads ends each by, and the PC it reads. */
const nativeReads = new Map<AbortController, string>();

/** The PC a server path reads: another PC's go through /api/machines/<id>/, the rest are this server's own. */
function readMachine(pathname: string): string {
  const remote = /^\/api\/machines\/([^/]+)\//.exec(pathname);
  return remote ? decodeURIComponent(remote[1]!) : "local";
}

function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
  const target = new URL(input instanceof Request ? input.url : String(input), origin);
  // only this server's reads: a write is never given up for the caller (the server may have done it),
  // and another host's connections were not found dead
  if ((method !== "GET" && method !== "HEAD") || target.origin !== origin || !target.pathname.startsWith("/api/")) return fetch(input, init);
  const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const read = new AbortController();
  // the caller's abort keeps reaching the body after the headers came
  let signal = read.signal;
  if (own && typeof AbortSignal.any === "function") signal = AbortSignal.any([own, read.signal]);
  else if (own?.aborted) read.abort(own.reason);
  else own?.addEventListener("abort", () => read.abort(own.reason), { once: true });
  nativeReads.set(read, readMachine(target.pathname));
  return fetch(input, { ...init, signal }).finally(() => { nativeReads.delete(read); });
}

/**
 * The connection to the server was found dead without a close (an unanswered probe): a read sent on
 * one of the browser's connections lost with it never answers, and holds one of the few connections
 * the browser keeps to a host, so every later request, the chat's reads too, waits behind it until
 * the browser gives that connection up, often a minute later. The reads still waiting are given up:
 * all of them for this server's own connection (its loss is the browser's path to the server), only
 * that PC's for another PC's, whose loss may be the server's own way to it.
 */
export function abandonNativeReads(machineId = "local"): void {
  for (const [read, machine] of nativeReads) {
    if (machineId !== "local" && machine !== machineId) continue;
    read.abort(new DOMException("The connection to the server was lost.", "AbortError"));
    nativeReads.delete(read);
  }
}

export const nativeTransport: Transport = {
  kind: "native",
  fetch: nativeFetch,
  openSocket: (url) => new WebSocket(url),
  openEventSource: (url) => new EventSource(url),
  resourceUrl: (path) => path,
};

let current: Transport = nativeTransport;

export function getTransport(): Transport {
  return current;
}

/** Called once at boot, before the first request; tests also restore the native one with it. */
export function setTransport(transport: Transport): void {
  current = transport;
}

/** A server path (`/api/…`) as the transport loads it; data:, blob: and other addresses stay as they are. */
export function serverResourceUrl(path: string, transport: Transport = current, signal?: AbortSignal): string | Promise<string> {
  return path.startsWith("/api/") ? transport.resourceUrl(path, signal) : path;
}
