import { paneStorageId } from "../../shared/machines.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

const COMMAND_CACHE_MS = 60_000;
const cache = new Map<string, { loadedAt: number; commands: SlashCommand[]; read: number }>();
/** per pane, how many times its lists were invalidated: a read begun before one is answered but not kept */
const generations = new Map<string, number>();
let reads = 0;
const listeners = new Set<(paneId: string, machineId: string) => void>();

/**
 * A pane's slash commands, asked for at most once a minute per PC, pane and agent: the composer's
 * menu and the chat's skill chips read the same answer, and a pane whose agent changed (a shell
 * that started one, an agent replaced by another) asks again for the new agent's list.
 */
export async function cachedPaneCommands(paneId: string, machineId: string, agent: string | null | undefined, fetchCommands: (pane: string) => Promise<SlashCommand[]>): Promise<SlashCommand[]> {
  const pane = paneStorageId(machineId, paneId);
  const key = `${pane}:${agent ?? ""}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.loadedAt < COMMAND_CACHE_MS) return cached.commands;
  const generation = generations.get(pane) ?? 0;
  const read = ++reads;
  const commands = await fetchCommands(paneId);
  // invalidated while on its way, or answering after a later read's answer was kept (a retry beside a refresh):
  // never kept. An answer that comes first is kept even while a later read is still on its way, so the other
  // components of the pane read it at once (paneCommandsNow); that later read replaces it when it answers
  const kept = cache.get(key);
  if ((generations.get(pane) ?? 0) === generation && (kept === undefined || kept.read < read)) cache.set(key, { loadedAt: Date.now(), commands, read });
  return commands;
}

/**
 * The list a read in the last minute answered for this PC, pane and agent, at once; null: none has. A
 * component whose own read is still on its way reads the answer another one already has.
 */
export function paneCommandsNow(paneId: string, machineId: string, agent: string | null | undefined): SlashCommand[] | null {
  const cached = cache.get(`${paneStorageId(machineId, paneId)}:${agent ?? ""}`);
  return cached && Date.now() - cached.loadedAt < COMMAND_CACHE_MS ? cached.commands : null;
}

/**
 * Forgets a pane's lists, whatever agent they were read for, and tells the listeners: a command
 * that changed the agent's catalog (an outcome's `catalog_changed`) is followed by a fresh read
 * where the pane's menu is open.
 */
export function invalidatePaneCommands(paneId: string, machineId: string): void {
  const pane = paneStorageId(machineId, paneId);
  for (const key of cache.keys()) if (key.startsWith(`${pane}:`)) cache.delete(key);
  generations.set(pane, (generations.get(pane) ?? 0) + 1);
  for (const listener of listeners) listener(paneId, machineId);
}

/** Called with the pane each invalidation names; the returned function stops the calls. */
export function onPaneCommandsInvalidated(listener: (paneId: string, machineId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
