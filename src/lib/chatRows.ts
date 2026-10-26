import type { ConversationResponse } from "../../shared/protocol.ts";

/**
 * One browser-local identity for one native conversation lifetime. `incarnation`
 * increments when a history without an ID is replaced in the same pane.
 */
export interface ChatRowScope {
  readonly machineId: string;
  readonly paneId: string;
  readonly historyId: string | null;
  readonly incarnation: number;
}

export interface ChatRowSlot {
  readonly key: string;
}

/**
 * The assigned slots for loaded logical rows. Slots are allocated only when a
 * known ingestion transition adds rows; immutable turn revisions reuse them.
 */
export interface ChatRowSlots {
  readonly scope: ChatRowScope;
  readonly rows: readonly ChatRowSlot[];
  readonly nextSlot: number;
}

function slotRows(scope: ChatRowScope, firstSlot: number, count: number): readonly ChatRowSlot[] {
  return Array.from({ length: count }, (_, offset) => ({
    key: JSON.stringify([scope.machineId, scope.paneId, scope.historyId, scope.incarnation, firstSlot + offset]),
  }));
}

export function createChatRowSlots(scope: ChatRowScope, count: number): ChatRowSlots {
  return { scope, rows: slotRows(scope, 0, count), nextSlot: count };
}

/**
 * Inserts rows at their known logical position without shifting existing row
 * identities. Use for both prepended pages and gap-fill pages.
 */
export function insertChatRowSlots(slots: ChatRowSlots, index: number, count: number): ChatRowSlots {
  const rows = slotRows(slots.scope, slots.nextSlot, count);
  return {
    scope: slots.scope,
    rows: [...slots.rows.slice(0, index), ...rows, ...slots.rows.slice(index)],
    nextSlot: slots.nextSlot + count,
  };
}

export function prependChatRowSlots(slots: ChatRowSlots, count: number): ChatRowSlots {
  return insertChatRowSlots(slots, 0, count);
}

export function appendChatRowSlots(slots: ChatRowSlots, count: number): ChatRowSlots {
  return insertChatRowSlots(slots, slots.rows.length, count);
}

/**
 * Whether a gjc answer under a new history ID goes on with the turns shown. gjc writes its whole
 * session anew and renames it over the old file (its first save, trimmed tool outputs), so the server
 * names it as another history. When the newest page still opens with every turn shown, in the same
 * places (its role, its start time, each part's kind, and a tool's name, call id and input; a trim
 * may shorten what a tool answered), the rows keep their identity. Anything else starts the chat
 * over: a page that now starts elsewhere (a compaction that dropped turns), any other agent's new
 * ID, or a turn that changed otherwise (a new session, a cleared context, a rewind, a moved branch).
 */
export function continuesHistory(shown: Pick<ConversationResponse, "source" | "turns"> | null, next: Pick<ConversationResponse, "source" | "turns">): boolean {
  if (shown === null || shown.source !== "gjc-transcript" || next.source !== shown.source) return false;
  if (shown.turns.length === 0 || next.turns.length < shown.turns.length) return false;
  return shown.turns.every((turn, index) => {
    const after = next.turns[index]!;
    return turn.ts !== null && after.role === turn.role && after.ts === turn.ts && after.parts.length >= turn.parts.length
      && turn.parts.every((part, at) => {
        const other = after.parts[at]!;
        return other.kind === part.kind && (part.kind !== "tool" || (other.kind === "tool" && other.name === part.name
          && other.call_id === part.call_id && other.input === part.input));
      });
  });
}
