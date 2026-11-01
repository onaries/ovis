import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { startHerdrCoreAdapter, type HerdrCoreAdapter } from "./adapter.ts";
import { HcConnection, spawnHcConnect } from "./connection.ts";

/**
 * Which runtime this PC's terminals run on. `OVIS_RUNTIME=herdr-core` serves the terminals of
 * herdr-core (`hc`), the core the Herdr desktop app runs on, in place of herdr's TUI server; unset,
 * or `herdr`, keeps herdr. Read once per process: a server does not change runtime while it runs.
 */
export type Runtime = "herdr" | "herdr-core";

export function runtime(): Runtime {
  const value = process.env["OVIS_RUNTIME"];
  if (value === undefined || value === "" || value === "herdr") return "herdr";
  if (value === "herdr-core") return "herdr-core";
  throw new Error(`OVIS_RUNTIME=${value} is not a runtime Ovis knows: use herdr (the default) or herdr-core`);
}

/** The `hc` to run: OVIS_HC_BIN, else `hc` on the PATH. */
export function hcBin(): string {
  return process.env["OVIS_HC_BIN"] || "hc";
}

let connection: HcConnection | null = null;
/** whether this process serves herdr-core (startRuntime ran): a remote bridge inheriting OVIS_RUNTIME does not */
let serving = false;

export function servingCore(): boolean {
  return serving;
}

/** The server's one line to hc, which the adapter answers through and live terminals stream on. */
export function coreConnection(): HcConnection {
  connection ??= new HcConnection(() => spawnHcConnect(hcBin()));
  return connection;
}

/**
 * On herdr-core, the adapter that answers herdr's API from hc (server/herdr-core/adapter.ts),
 * listening in the state folder, and HERDR_SOCKET pointed at it before anything reads it; on
 * herdr, nothing. Another Ovis still serving the same state folder is an error: nothing is started.
 */
export async function startRuntime(stateDir: string): Promise<HerdrCoreAdapter | null> {
  if (runtime() !== "herdr-core") return null;
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("OVIS_RUNTIME=herdr-core is Linux/macOS only: no Windows named pipe support yet");
  }
  // the state folder is otherwise created on first write: the socket goes there first
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (statSync(stateDir).uid !== process.geteuid?.()) throw new Error("the herdr-core state directory is not owned by this user");
  chmodSync(stateDir, 0o700);
  const hc = coreConnection();
  const adapter = await startHerdrCoreAdapter(hc, join(stateDir, "herdr-core.sock"));
  chmodSync(adapter.socketPath, 0o600);
  process.env["HERDR_SOCKET"] = adapter.socketPath;
  serving = true;
  return {
    socketPath: adapter.socketPath,
    stop: () => {
      adapter.stop();
      hc.close();
      connection = null;
      serving = false;
    },
  };
}
