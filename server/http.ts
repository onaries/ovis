/**
 * The `{ error: { code, message } }` envelope every Ovis route answers with.
 *
 * It lives outside index.ts because the auth routes must fail in exactly the shape
 * the pane routes fail in: a second copy of this envelope is how one API ends up
 * with two error formats and a client that only handles one of them.
 */

import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { FileBusyError } from "./file-pool.ts";
import { HerdrError } from "./herdr/client.ts";

/** The outer HTTP boundary also correlates errors caught inside route handlers. */
export const requestIdContext = new AsyncLocalStorage<{ readonly id: string; route: string }>();

/** Call only from a matched dispatch branch, with a fixed template or a finite matched literal. */
export function setRequestRoute(route: string): void {
  const context = requestIdContext.getStore();
  if (context !== undefined) context.route = route;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A non-negative integer: a row, a column or a scroll offset. */
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HerdrError) {
    const status = error.code === "connect_failed" || error.code === "timeout" ? 502 : 404;
    return jsonResponse({ error: { code: error.code, message: error.message } }, status);
  }
  // every file thread busy, or the disk too slow to answer in time (file-pool.ts): worth another try soon
  if (error instanceof FileBusyError) return jsonResponse({ error: { code: error.code, message: error.message } }, 503, { "retry-after": "1" });
  // A system error carries absolute paths, the herdr socket and whatever a dependency
  // throws; the client is told none of it but a handle to quote in a bug report, and the
  // real exception is logged here beside that handle. Short enough to say out loud, long
  // enough that nobody reads another's.
  const id = requestIdContext.getStore()?.id ?? randomBytes(6).toString("hex");
  console.error(`internal_error ${id}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return jsonResponse({ error: { code: "internal_error", message: `internal error (${id})` } }, 500);
}

export function conflictResponse(code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, 409);
}

export function badRequest(code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, 400);
}

/** A JSON route's body as an object, or the 400 that says it is not JSON or not an object. */
export async function readJsonObject<T extends object = Record<string, unknown>>(request: Request): Promise<T | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_json", "request body must be JSON");
  }
  if (!isJsonObject(body)) return badRequest("invalid_body", "request body must be a JSON object");
  return body as T;
}
