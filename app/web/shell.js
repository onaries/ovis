// Shared by the app's own pages: the native plugin (ios/App/App/HerdrShellPlugin.swift) and
// what an address typed or scanned becomes.

/**
 * The hosted shell's origin (app.ovis.sh), where a PC paired over the Ovis relay opens, at its scope
 * `/s/<server_id>/`. app/scripts/build-web.ts puts in another for a test build (OVIS_APP_URL).
 */
export const APP_ORIGIN = "https://app.ovis.sh";

/** Whether the connect screen offers signing in to the account (the hosted shell's front page); app/scripts/build-web.ts turns it on with OVIS_APP_ACCOUNT=1. */
export const ACCOUNT_SIGN_IN = false;

/** Whether the phone's first language is Korean, the one language the app's own pages have besides English. */
export const korean = /^ko\b/i.test(navigator.language ?? "");

/** The text in the phone's language. */
export function t(en, ko) {
  return korean ? ko : en;
}

/** On a Korean phone, puts in each element's data-ko text, as text: a page with the native bridge has no HTML sink. */
export function localize() {
  if (!korean) return;
  document.documentElement.lang = "ko";
  for (const element of document.querySelectorAll("[data-ko]")) element.textContent = element.dataset.ko;
}

/** Calls the native HerdrShell plugin through Capacitor's bridge. */
export function shell(method, options = {}) {
  return window.Capacitor.nativePromise("HerdrShell", method, options);
}

/**
 * Whether opening url sends a pairing code and everything typed over the internet unencrypted:
 * plain http to an address outside a tailnet, a home network and this phone. The apps allow
 * cleartext to any host, as Android cannot limit it to address ranges.
 */
export function publicHttp(url) {
  return url.protocol === "http:" && !homeHost(url.hostname);
}

/** Whether `hostname` (a URL's) is this phone itself: localhost, 127.0.0.0/8 or ::1. */
export function loopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host) || host === "::1";
}

/** Whether `hostname` is a MagicDNS name or a Tailscale IP (100.64.0.0/10, fd7a:115c:a1e0::/48), which opens only while Tailscale is on; error.html has the same test. */
export function tailnetHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = host.match(/^100\.(\d+)\.\d+\.\d+$/);
  return host.endsWith(".ts.net") || (ipv4 !== null && Number(ipv4[1]) >= 64 && Number(ipv4[1]) <= 127) || host.startsWith("fd7a:115c:a1e0:");
}

/**
 * Whether `hostname` is an address of a home network or a tailnet, which opens only from inside it:
 * this phone itself, a private or link-local IP, a Tailscale address, a one-word name or a name
 * under .local, .lan, .home.arpa or .internal. Any other name is a public server. error.html has
 * the same test.
 */
export function homeHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (loopbackHost(host) || tailnetHost(host)) return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    // 10/8, 172.16/12, 192.168/16 and link-local 169.254/16 (127/8 and Tailscale's 100.64/10 above)
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  // unique local fc00::/7 and link-local fe80::/10 (::1 above)
  if (host.includes(":")) return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  // a one-word name (a MagicDNS short name) or a home network name
  return !host.includes(".") || /\.(local|lan|home\.arpa|internal)$/.test(host);
}

/** How long the Android app waits for an address to answer before it says so (PCStore.ANSWER_SECONDS), as the iOS app's cover waits. */
export const ANSWER_SECONDS = 20;

/**
 * Why `url` did not open, for the connect screen, from the HerdrShell open's refusal: its `code`
 * (PCStore.check's kind) and `message` (the answer that was not Ovis, or the error). "" for a
 * cancelled open.
 */
export function openFailure(url, code, message) {
  const host = url.host;
  const tailscale = tailnetHost(url.hostname) ? " " + t(
    "This is a Tailscale address, and Tailscale may be off on this phone: turn it on in the Tailscale app.",
    "Tailscale 주소입니다. 이 휴대폰에서 Tailscale이 꺼져 있을 수 있으니 Tailscale 앱에서 연결을 켜세요.",
  ) : "";
  const where = t(
    "Open the address Ovis shows under Settings → Phone & devices on the PC.",
    "PC의 Ovis에서 설정 → 폰 및 기기에 표시된 주소를 여세요.",
  );
  switch (code) {
    case "cancelled": return "";
    case "not-ovis": {
      const answer = /^HTTP \d{3}$/.test(message ?? "") ? ` (${message})` : "";
      return t(
        `${host} answered${answer}, but it is not Ovis: another web server, or herdr itself, which the app cannot open. ${where}`,
        `${host}이(가) 응답했지만${answer} Ovis가 아닙니다. 다른 웹 서버이거나, 앱이 열 수 없는 herdr 자체입니다. ${where}`,
      );
    }
    case "refused": return refusedHelp(url, host);
    case "timeout": return (homeHost(url.hostname) ? t(
      `${host} did not answer within ${ANSWER_SECONDS} seconds. The PC may be off, or out of this phone's reach: a home network address does not open over mobile data or another Wi-Fi, and a firewall on the PC can block the port.`,
      `${host}이(가) ${ANSWER_SECONDS}초 안에 응답하지 않았습니다. PC가 꺼져 있거나 이 휴대폰에서 닿지 않을 수 있습니다. 집 네트워크 주소는 모바일 데이터나 다른 Wi-Fi에서 열리지 않고, PC의 방화벽이 포트를 막을 수도 있습니다.`,
    ) : t(
      `Nothing came back from ${host} within ${ANSWER_SECONDS} seconds. The server may be down, or this phone's connection (or a VPN on it) may not reach it.`,
      `${ANSWER_SECONDS}초 동안 ${host}에서 아무 응답도 오지 않았습니다. 서버가 꺼져 있거나, 이 휴대폰의 연결(또는 VPN)이 서버에 닿지 않을 수 있습니다.`,
    )) + tailscale;
    case "unknown-host": return t(
      `${url.hostname} was not found. Check the name, or open the address Ovis shows under Settings → Phone & devices on the PC.`,
      `${url.hostname}을(를) 찾지 못했습니다. 이름을 확인하거나, PC의 Ovis에서 설정 → 폰 및 기기에 표시된 주소를 여세요.`,
    ) + tailscale;
    default: return t(`${host} could not be reached: ${message}`, `${host}에 연결할 수 없습니다: ${message}`) + tailscale;
  }
}

/** What a refused connection means: nothing listens on that address and port. */
function refusedHelp(url, host) {
  const text = t(
    `${host} refused the connection: nothing listens there. Ovis has to run on the PC (herdr alone is not enough), and by default it listens only on the PC itself (127.0.0.1). Open the address Ovis shows under Settings → Phone & devices on the PC.`,
    `${host}이(가) 연결을 거부했습니다. 그 주소에서 기다리는 것이 없습니다. PC에서 Ovis가 실행 중이어야 하고(herdr만으로는 안 됩니다), Ovis는 기본으로 PC 자신(127.0.0.1)에서만 기다립니다. PC의 Ovis에서 설정 → 폰 및 기기에 표시된 주소를 여세요.`,
  );
  return loopbackHost(url.hostname) ? text + " " + t(
    "On a phone, localhost and 127.0.0.1 are the phone itself, not your PC.",
    "휴대폰에서 localhost와 127.0.0.1은 PC가 아니라 휴대폰 자신입니다.",
  ) : text;
}

/**
 * What the user typed or scanned, as the URL to open, or null. A missing scheme becomes
 * http for an IPv4 address (a tailnet or LAN IP, served plain) and https for a name.
 * A pairing link (`?pair=CODE`, the PC's QR code) keeps its code.
 */
export function parseAddress(text) {
  let value = String(text).trim();
  if (value === "") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(value) ? "http://" : "https://") + value;
  let url;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
  return url;
}

const OFFER = "#offer=";
const SCOPE = /^\/s\/([0-9a-f]{32})\/?$/;

/**
 * What `url` (from parseAddress) opens through the Ovis relay, or null for a PC's own address.
 * A PC's page on the app's origin, `/s/<server_id>/`, with its pairing offer (`#offer=`, the QR code
 * the PC shows for the relay) or without (a PC saved before), is `{ url, scope, name }`: the address
 * to open, the fragment kept, the scope the app saves the PC under, and its label from the offer.
 * Anything else is `{ error }`: "foreign-offer" for an offer on another origin, which only the app's
 * origin may take, "bad-offer" for an offer that does not name this scope's PC, and "not-a-pc" for
 * another page of the app's origin. The hosted shell checks the offer in full before it pairs.
 */
export function relayLink(url, appOrigin = APP_ORIGIN) {
  if (url.origin !== new URL(appOrigin).origin) return url.hash.startsWith(OFFER) ? { error: "foreign-offer" } : null;
  const serverId = SCOPE.exec(url.pathname)?.[1];
  if (serverId === undefined) return { error: "not-a-pc" };
  const scope = `${url.origin}/s/${serverId}/`;
  if (url.hash === "") return { url: scope, scope, name: undefined };
  if (!url.hash.startsWith(OFFER)) return { error: "not-a-pc" };
  const offer = offerOf(url.hash.slice(OFFER.length));
  if (offer === null || offer.server_id !== serverId) return { error: "bad-offer" };
  return { url: scope + url.hash, scope, name: offer.name };
}

/** The offer's `server_id` and `name` from its base64url JSON, or null when it is none. */
function offerOf(payload) {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(payload) || payload.length % 4 === 1) return null;
  let offer;
  try {
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    offer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch { return null; }
  if (typeof offer !== "object" || offer === null || offer.v !== 1 || typeof offer.server_id !== "string") return null;
  if (offer.name !== undefined && (typeof offer.name !== "string" || offer.name.length > 64)) return null;
  return { server_id: offer.server_id, name: offer.name === "" ? undefined : offer.name };
}
