/**
 * Where herdr-core's adapter (adapter.ts) listens for the server's herdr client. On Linux and macOS
 * it is `herdr-core.sock` in the state folder. Windows has no unix socket file to hand the client, so
 * there it is a named pipe, as herdr's own server and hc's core listen on (live-verified in the
 * Windows VM: Bun.listen and Bun.connect take `\\.\pipe\…`, a second listener on the same name is
 * refused with EADDRINUSE, and a pipe whose server ended answers ENOENT, so the adapter's "another
 * Ovis still listens" check holds as it is).
 *
 * The name comes from the state folder, so two servers on one state folder still meet on one pipe
 * and the second is refused, as two on one socket file are. Windows paths ignore case: the folder
 * is resolved and lowercased first.
 */
import { createHash } from "node:crypto";
import { join, win32 } from "node:path";

const PIPE_PREFIX = "\\\\.\\pipe\\";

export function adapterAddress(stateDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return join(stateDir, "herdr-core.sock");
  const digest = createHash("sha256").update(win32.resolve(stateDir).toLowerCase()).digest("hex").slice(0, 32);
  return `${PIPE_PREFIX}ovis-herdr-core-${digest}`;
}

/** a Windows named pipe's address, which has no file behind it to read or stat for identity */
export function isNamedPipe(path: string): boolean {
  return path.startsWith(PIPE_PREFIX);
}

const STARTED = crypto.randomUUID();

/**
 * The herdr identity of a pipe (finishes.ts, completion.ts), read without touching it. Its name is
 * the same on every start, but the adapter behind it is this server's own, as the socket file
 * recreated on every start is on Linux and macOS: the identity is new for each server process.
 */
export function pipeIdentity(path: string): string {
  return `${path}#${STARTED}`;
}
