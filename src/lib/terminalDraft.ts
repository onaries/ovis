/** Unsent terminal lines belong to a PC/pane, never to the currently mounted view. */
const listeners = new Set<() => void>();
const pending = new Map<string, { written: string; canClear: boolean }>();
export function subscribeTerminalDraft(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function notify(): void { for (const listener of listeners) listener(); }
export function terminalDraftSending(owner: string): boolean { return pending.has(owner); }
export function setTerminalDraftSending(owner: string, value: boolean): void {
  if (value) pending.set(owner, { written: readTerminalDraft(owner), canClear: true });
  else pending.delete(owner);
  notify();
}
const memory = new Map<string, string>();
/** how many times each owner's draft was written: a paste that waited on the clipboard compares it (TerminalInput.tsx) */
const versions = new Map<string, number>();
export function terminalDraftVersion(owner: string): number { return versions.get(owner) ?? 0; }
const PREFIX = "ovis:terminal-line:";
export const TERMINAL_LINE_LIMIT = 32_768;
export function readTerminalDraft(owner: string): string {
  if (memory.has(owner)) return memory.get(owner)!;
  try { return (localStorage.getItem(PREFIX + owner) ?? "").slice(0, TERMINAL_LINE_LIMIT); } catch { return ""; }
}
export function writeTerminalDraft(owner: string, text: string): void {
  const value = text.slice(0, TERMINAL_LINE_LIMIT).replace(/[\uD800-\uDBFF]$/, "");
  const sent = pending.get(owner);
  if (sent && !value.startsWith(sent.written)) sent.canClear = false;
  memory.set(owner, value);
  versions.set(owner, terminalDraftVersion(owner) + 1);
  try {
    if (value) localStorage.setItem(PREFIX + owner, value);
    else localStorage.removeItem(PREFIX + owner);
  } catch { /* private mode: preserve across view changes in memory */ }
  notify();
}

/** An acknowledgement removes only the unchanged sent prefix, never replacement text. */
export function acknowledgeTerminalDraft(owner: string): void {
  const sent = pending.get(owner);
  const current = readTerminalDraft(owner);
  if (sent?.canClear && current.startsWith(sent.written)) writeTerminalDraft(owner, current.slice(sent.written.length));
}
