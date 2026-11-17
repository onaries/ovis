export const DEFAULT_ACCOUNT_SERVICE = "https://account.ovis.sh";
export const accountServiceOff = (value: string): boolean => value.trim().toLowerCase() === "off";

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

/**
 * - `script-src 'self' 'wasm-unsafe-eval'`: `'wasm-unsafe-eval'` lets the page compile WebAssembly
 *   and nothing else (no eval, no string to script): the terminal's sixel decoder
 *   (@xterm/addon-image, Settings -> Pictures in the terminal) and libghostty-vt (which draws
 *   every terminal) are modules bundled in the app.
 * - `style-src 'self' 'unsafe-inline'`: xterm.js builds its layers by appending a <style> element
 *   to the DOM, and a DOM-inserted <style> is subject to style-src, so without 'unsafe-inline' the
 *   pane loses its cursor and its layers.
 * - `font-src 'self' data:`: the `data:` is Vite's own inlining: an asset under ~4 KB
 *   is emitted as a data: URL inside the CSS rather than as a file, and KaTeX_Size3's
 *   3 KB woff2 is one of them.
 * - `connect-src 'self'`: the terminal socket is window.location.host over ws:/wss: (which
 *   'self' matches — confirmed in Chromium).
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

const SHELL_SOURCES: Record<string, string> = {
  "connect-src": `'self' wss: ${DEFAULT_ACCOUNT_SERVICE}`,
  "media-src": "'self' blob:",
  "frame-src": "'self' blob:",
};

export function shellContentSecurityPolicy(connect: readonly string[] = []): string {
  return CSP_DIRECTIVES.map((directive) => {
    const name = directive.slice(0, directive.indexOf(" "));
    const sources = SHELL_SOURCES[name];
    if (sources === undefined) return directive;
    return name === "connect-src" && connect.length ? `${name} ${sources} ${connect.join(" ")}` : `${name} ${sources}`;
  }).join("; ");
}

export function accountServiceOrigin(value = process.env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE): string | null {
  if (!value || accountServiceOff(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^[a-z0-9.-]+(?::[0-9]+)?$/i.test(url.host) ? url.origin : null;
  } catch { return null; }
}

/**
 * No hash or nonce is ever added to it, since a hash in `script-src` would make browsers ignore
 * `'unsafe-inline'` and block the page's own inline scripts.
 */
export const pagePolicy = (mediaSource: string | null): string => [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data:",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  mediaSource === null ? "media-src data: blob:" : `media-src data: blob: ${mediaSource}`,
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");
