/**
 * Where a reader left one pane's chat: the turn at the top of the view and how far below the
 * view's top edge it started, or `atEnd` while the reader followed the end. Kept in memory, one
 * entry per `paneStorageId(machineId, paneId)`, and in the tab's session storage too, so a reload
 * opens the chat where the reader was (a position names its history, so a conversation replaced
 * since lands at the end as before).
 */
export interface ChatPosition {
  readonly historyId: string | null;
  readonly turn: string;
  /** the turn's top minus the view's top, in CSS pixels (negative: it started above the view) */
  readonly offset: number;
  readonly atEnd: boolean;
}

const LIMIT = 100;
const STORAGE_KEY = "ovis:chat-positions";
/** a scroll remembers on every event: the store is written once this long after the last, and as the page leaves */
const SAVE_AFTER_MS = 250;
const positions = new Map<string, ChatPosition>();
let loaded = false;
let saveTimer: number | null = null;

import { searchPattern } from "../../shared/conversation-search.ts";

/** A turn's identity that survives a remount, the one a conversation search names its matches by. */
export { conversationTurnAnchor as chatTurnAnchor } from "../../shared/conversation-search.ts";

/** Node.TEXT_NODE, which a page without a DOM (a test) does not define */
const TEXT_NODE = 3;

/** The DOM a match is looked for in: a DOM Node, or a test's tree of the same shape. */
export interface DrawnNode<N> { readonly nodeType: number; readonly nodeName: string; readonly nodeValue: string | null; readonly childNodes: ArrayLike<N> }
export interface DrawnSpan<N> { readonly start: N; readonly startOffset: number; readonly end: N; readonly endOffset: number }

// elements whose end parts the text the search reads as a line break does
const LINE_ENDS = new Set(["BR", "P", "DIV", "LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TR"]);

/**
 * Where a search's matched words are drawn in `root`: the first place its pattern (searchPattern: the
 * words in order, any whitespace between them, case ignored) finds them in the drawn text, also when
 * formatting splits them over text nodes (bold, code, a link) or a line break parts them. Null: not drawn there.
 */
export function drawnMatch<N extends DrawnNode<N>>(root: N, words: string): DrawnSpan<N> | null {
  const pattern = searchPattern(words);
  if (pattern === null) return null;
  // each text node's place in the joined text; a line break is a "\n" no node holds
  const nodes: { node: N; at: number }[] = [];
  let text = "";
  const walk = (node: N): void => {
    if (node.nodeType === TEXT_NODE) { nodes.push({ node, at: text.length }); text += node.nodeValue ?? ""; return; }
    for (let index = 0; index < node.childNodes.length; index++) walk(node.childNodes[index]!);
    if (LINE_ENDS.has(node.nodeName.toUpperCase())) text += "\n";
  };
  walk(root);
  const found = pattern.exec(text);
  if (found === null) return null;
  // the match begins and ends on a word, so both ends fall in a text node
  const holding = (index: number): { node: N; at: number } => {
    let held = nodes[0]!;
    for (const item of nodes) if (item.at <= index) held = item;
    return held;
  };
  const first = holding(found.index), last = holding(found.index + found[0].length - 1);
  return { start: first.node, startOffset: found.index - first.at, end: last.node, endOffset: found.index + found[0].length - last.at };
}

const storage = (): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null => {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
};

function isPosition(value: unknown): value is ChatPosition {
  if (typeof value !== "object" || value === null) return false;
  const { historyId, turn, offset, atEnd } = value as Partial<ChatPosition>;
  return (historyId === null || typeof historyId === "string") && typeof turn === "string" && typeof offset === "number" && Number.isFinite(offset) && typeof atEnd === "boolean";
}

/** The positions the tab stored, read once before anything is remembered: what this page remembers since comes after them. */
function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const value: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(value)) return;
    for (const entry of value.slice(-LIMIT)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && isPosition(entry[1])) positions.set(entry[0], { historyId: entry[1].historyId, turn: entry[1].turn, offset: entry[1].offset, atEnd: entry[1].atEnd });
    }
  } catch { /* unreadable: this page's own memory is all there is */ }
}

function save(): void {
  if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; }
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify([...positions])); } catch { /* storage refused: this page's memory keeps it */ }
}

function scheduleSave(): void {
  if (typeof window === "undefined" || saveTimer !== null) return;
  saveTimer = window.setTimeout(save, SAVE_AFTER_MS);
}

// a reload leaves at once: what the last scroll remembered is written on the way out
if (typeof window !== "undefined") window.addEventListener("pagehide", () => { if (saveTimer !== null) save(); });

export function rememberChatPosition(storageId: string, position: ChatPosition): void {
  load();
  positions.delete(storageId);
  positions.set(storageId, position);
  if (positions.size > LIMIT) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
  scheduleSave();
}

export function readChatPosition(storageId: string): ChatPosition | undefined {
  load();
  return positions.get(storageId);
}

/** herdr moved the pane under a new ID (#1503): its chat reads on where the reader left it; a place the new ID has stays. */
export function moveChatPosition(from: string, to: string): void {
  load();
  const left = positions.get(from);
  if (left === undefined || from === to) return;
  positions.delete(from);
  if (!positions.has(to)) rememberChatPosition(to, left);
  else scheduleSave();
}

export function forgetChatPositions(): void {
  loaded = true;
  positions.clear();
  save();
}

/**
 * The row to put back at the top of the view, or null to land at the end: the reader followed
 * the end, the conversation was replaced since (another history), or the turn is not among the
 * rows loaded now (an earlier page the new mount has not read).
 */
export function chatRestoreIndex(position: ChatPosition | undefined, historyId: string | null, anchors: readonly string[]): number | null {
  if (position === undefined || position.atEnd || position.historyId !== historyId) return null;
  const index = anchors.indexOf(position.turn);
  return index < 0 ? null : index;
}
