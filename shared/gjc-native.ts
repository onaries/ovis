import { isAbsolute } from "node:path";

/** The GJC extension publishes only identity, never conversation contents. */
export interface GjcNativeBinding {
  version: 1;
  pid: number;
  processStartedAt: number;
  instanceId: string;
  /** Changes only with session identity; heartbeats refresh updatedAt alone. */
  sequence: number;
  updatedAt: number;
  session: { id: string; path: string; cwd: string } | null;
}

export const GJC_NATIVE_DIRECTORY = "herdr-web-ui";
export const GJC_NATIVE_HEARTBEAT_MS = 2_000;
export const GJC_NATIVE_LEASE_MS = 10_000;

const recordKeys = ["version", "pid", "processStartedAt", "instanceId", "sequence", "updatedAt", "session"] as const;
const sessionKeys = ["id", "path", "cwd"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Shared shape only; readers apply their own process identity and lease checks. */
export function isGjcNativeBindingShape(value: unknown): value is GjcNativeBinding {
  if (!isRecord(value) || !hasExactKeys(value, recordKeys)) return false;
  if (value.version !== 1 || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.processStartedAt !== "number" || !Number.isSafeInteger(value.processStartedAt) || value.processStartedAt <= 0
    || typeof value.instanceId !== "string" || value.instanceId.length === 0 || value.instanceId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.instanceId)
    || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.updatedAt !== "number" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.processStartedAt) return false;
  if (value.session === null) return true;
  const session = value.session;
  return isRecord(session) && hasExactKeys(session, sessionKeys)
    && typeof session.id === "string" && session.id !== ""
    && typeof session.path === "string" && isAbsolute(session.path)
    && typeof session.cwd === "string" && isAbsolute(session.cwd);
}
