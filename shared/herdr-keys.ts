/**
 * herdr's `[keys]` as herdr resolves them (src/config/keybinds.rs, `validated_keybinds`), for the
 * prefix-mode actions the app can run itself (Settings → Shortcuts → Use herdr's prefix keys).
 * Every other action, direct (non-prefix) binding and `[[keys.command]]` stays herdr's: they are
 * read only to know which keys they take from a default, never returned.
 */

/** The actions the app runs (lib/herdrKeys.ts runHerdrAction). */
export const HERDR_PREFIX_ACTIONS = [
  "help", "settings", "workspace_picker", "goto", "new_workspace", "previous_workspace", "next_workspace",
  "new_tab", "rename_tab", "previous_tab", "next_tab", "switch_tab", "split_vertical", "split_horizontal", "zoom", "toggle_sidebar",
] as const;

export type HerdrPrefixAction = (typeof HERDR_PREFIX_ACTIONS)[number];

/** herdr's prefixes and, for each action the app runs, the bindings herdr keeps for it, as written. */
export interface HerdrKeys {
  /** the first of `prefixes`, kept for clients from before prefix lists */
  prefix: string;
  /** every prefix key, each of which enters prefix mode (herdr's `prefix` then `extra_prefixes`) */
  prefixes: string[];
  bindings: Record<HerdrPrefixAction, string[]>;
}

/** Every herdr action outside navigate mode, in the order herdr registers them, with its default ("" unbound). */
const FIELDS: readonly (readonly [field: string, defaults: string])[] = [
  ["help", "prefix+?"], ["settings", "prefix+s"], ["new_workspace", "prefix+shift+n"], ["new_worktree", "prefix+shift+g"],
  ["open_worktree", ""], ["remove_worktree", ""], ["rename_workspace", "prefix+shift+w"], ["close_workspace", "prefix+shift+d"],
  ["workspace_picker", "prefix+w"], ["goto", "prefix+g"], ["detach", "prefix+q"], ["reload_config", "prefix+shift+r"],
  ["open_notification_target", "prefix+o"], ["previous_workspace", ""], ["next_workspace", ""], ["previous_agent", ""],
  ["next_agent", ""], ["focus_agent", ""], ["new_tab", "prefix+c"], ["rename_tab", "prefix+shift+t"], ["previous_tab", "prefix+p"],
  ["next_tab", "prefix+n"], ["move_tab_previous", ""], ["move_tab_next", ""], ["switch_tab", "prefix+1..9"], ["switch_workspace", ""],
  ["close_tab", "prefix+shift+x"], ["rename_pane", "prefix+shift+p"], ["edit_scrollback", "prefix+e"], ["clear_pane", ""],
  ["copy_mode", "prefix+["], ["focus_pane_left", "prefix+h"],
  ["focus_pane_down", "prefix+j"], ["focus_pane_up", "prefix+k"], ["focus_pane_right", "prefix+l"], ["swap_pane_left", "prefix+shift+h"],
  ["swap_pane_down", "prefix+shift+j"], ["swap_pane_up", "prefix+shift+k"], ["swap_pane_right", "prefix+shift+l"], ["last_pane", ""],
  ["cycle_pane_next", "prefix+tab"], ["cycle_pane_previous", "prefix+shift+tab"], ["split_vertical", "prefix+v"],
  ["split_horizontal", "prefix+minus"], ["close_pane", "prefix+x"], ["zoom", "prefix+z"], ["resize_mode", "prefix+r"],
  ["resize_pane_left", ""], ["resize_pane_down", ""], ["resize_pane_up", ""], ["resize_pane_right", ""], ["toggle_sidebar", "prefix+b"],
];
/** indexed actions and the `[keys.indexed]` entry that displaces their default */
const INDEXED: Readonly<Record<string, string>> = { focus_agent: "agents", switch_tab: "tabs", switch_workspace: "workspaces" };
const DEFAULT_PREFIX = "ctrl+b";

export interface HerdrChord {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  /** herdr's hyper: no browser reports it, so a chord with it never matches a key */
  readonly hyper: boolean;
  /** a lowercase letter, a digit, a punctuation character or space, or a KeyboardEvent.key name (Tab, Escape, ArrowLeft, F1) */
  readonly key: string;
}

export type HerdrBinding =
  | { readonly prefixed: boolean; readonly range: false; readonly chord: HerdrChord }
  /** `1..9`: one chord per digit, `key` left empty */
  | { readonly prefixed: boolean; readonly range: true; readonly chord: HerdrChord };

type Modifier = "ctrl" | "alt" | "shift" | "meta" | "hyper";
const MODIFIERS: ReadonlyMap<string, Modifier> = new Map([
  ["ctrl", "ctrl"], ["control", "ctrl"], ["shift", "shift"], ["alt", "alt"], ["option", "alt"], ["meta", "alt"],
  ["cmd", "meta"], ["command", "meta"], ["super", "meta"], ["hyper", "hyper"],
]);
const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ["space", " "], [" ", " "], ["enter", "Enter"], ["return", "Enter"], ["esc", "Escape"], ["escape", "Escape"], ["tab", "Tab"],
  ["backspace", "Backspace"], ["bs", "Backspace"], ["left", "ArrowLeft"], ["right", "ArrowRight"], ["up", "ArrowUp"], ["down", "ArrowDown"],
  ["minus", "-"], ["comma", ","], ["period", "."], ["slash", "/"], ["backslash", "\\"], ["quote", "'"], ["double_quote", "\""],
  ["double-quote", "\""], ["semicolon", ";"], ["colon", ":"], ["percent", "%"], ["ampersand", "&"], ["backtick", "`"], ["plus", "+"],
]);

/** herdr's `parse_binding_string`: `prefix+` first, then modifiers and one key in any order, or `1..9` with modifiers only. */
export function parseHerdrBinding(raw: string): HerdrBinding | null {
  const trimmed = raw.trim();
  const prefixed = trimmed.startsWith("prefix+");
  const body = (prefixed ? trimmed.slice("prefix+".length) : trimmed).trim();
  const flags = { ctrl: false, alt: false, shift: false, meta: false, hyper: false };
  // a literal plus is the key after the last separator: `+` alone, or modifiers then `++`
  if (body === "+" || body.endsWith("++")) {
    for (const part of body === "+" ? [] : body.slice(0, -2).split("+")) {
      const modifier = MODIFIERS.get(part.trim().toLowerCase());
      if (modifier === undefined) return null;
      flags[modifier] = true;
    }
    return { prefixed, range: false, chord: { ...flags, key: "+" } };
  }
  const parts = body.split("+").map((part) => part.trim());
  if (parts.some((part) => part === "")) return null;
  let key: string | null = null;
  let range = false;
  for (const part of parts) {
    const modifier = MODIFIERS.get(part.toLowerCase());
    if (modifier !== undefined) flags[modifier] = true;
    else if (part === "1..9" && !range && key === null) range = true;
    else if (key !== null || range) return null;
    else key = part;
  }
  if (range) return { prefixed, range: true, chord: { ...flags, key: "" } };
  if (key === null) return null;
  const named = NAMED_KEYS.get(key.toLowerCase());
  if (named !== undefined) return { prefixed, range: false, chord: { ...flags, key: named } };
  if ([...key].length === 1) {
    // an ASCII capital is Shift and its letter, as herdr reads it
    return /^[A-Z]$/.test(key) ? { prefixed, range: false, chord: { ...flags, shift: true, key: key.toLowerCase() } } : { prefixed, range: false, chord: { ...flags, key } };
  }
  const f = /^f(\d{1,3})$/i.exec(key);
  return f && Number(f[1]) <= 255 ? { prefixed, range: false, chord: { ...flags, key: `F${Number(f[1])}` } } : null;
}

/** The chords a binding of `field` stands for, each with the index it picks: a range is its nine digits, and an indexed action's lone digit is that index. */
export function bindingChords(binding: HerdrBinding, field: string): { chord: HerdrChord; index: number | null }[] {
  if (binding.range) return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => ({ chord: { ...binding.chord, key: String(index) }, index }));
  return [{ chord: binding.chord, index: Object.hasOwn(INDEXED, field) && /^[1-9]$/.test(binding.chord.key) ? Number(binding.chord.key) : null }];
}

function chordId(chord: HerdrChord): string {
  return `${+chord.ctrl}${+chord.alt}${+chord.shift}${+chord.meta}${+chord.hyper}:${chord.key}`;
}

function bindingValues(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function table(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The prefixes and the prefix bindings herdr keeps for each action the app runs, from config.toml's
 * `[keys]` (`keys`: that table, or anything else for none). As herdr: `prefix` and `extra_prefixes`
 * (one key or a list each) are every prefix, an entry it cannot read skipped and a repeat kept once,
 * ctrl+b when none is left; a field the config writes beats a default on the same key (every field
 * the user wrote, custom commands included, registers first,
 * then the defaults, each pass in herdr's field order), the first binding of a key keeps it, a prefix
 * binding on any prefix is dropped (the prefix twice sends the prefix), and a range belongs to an
 * indexed action only and an indexed one takes digits only. A value of the wrong type makes herdr
 * read no config at all: its defaults stand.
 */
export function resolveHerdrKeys(keys: unknown): HerdrKeys {
  let user = table(keys) ?? {};
  // zoom's legacy name
  if (!Object.hasOwn(user, "zoom") && Object.hasOwn(user, "fullscreen")) user = { ...user, zoom: user["fullscreen"] };
  const indexed = Object.hasOwn(user, "indexed") ? table(user["indexed"]) : {};
  const commands = Object.hasOwn(user, "command") ? user["command"] : [];
  const wellTyped = ["prefix", "extra_prefixes", ...FIELDS.map(([field]) => field)].every((field) => !Object.hasOwn(user, field) || bindingValues(user[field]) !== null)
    && indexed !== null && Object.values(indexed).every((value) => typeof value === "string")
    && Array.isArray(commands) && commands.every((command) => table(command) !== null);
  if (!wellTyped) return resolveHerdrKeys(undefined);
  const prefixes: string[] = [];
  const prefixIds = new Set<string>();
  for (const raw of ["prefix", "extra_prefixes"].flatMap((field) => Object.hasOwn(user, field) ? bindingValues(user[field]) ?? [] : [])) {
    const parsed = parseHerdrBinding(raw);
    if (parsed === null || parsed.prefixed || parsed.range || prefixIds.has(chordId(parsed.chord))) continue;
    prefixIds.add(chordId(parsed.chord));
    prefixes.push(raw.trim());
  }
  if (prefixes.length === 0) {
    prefixes.push(DEFAULT_PREFIX);
    prefixIds.add(chordId((parseHerdrBinding(DEFAULT_PREFIX) as HerdrBinding).chord));
  }
  const taken = new Set<string>();
  const bindings = Object.fromEntries(HERDR_PREFIX_ACTIONS.map((action) => [action, [] as string[]])) as HerdrKeys["bindings"];
  const supported = new Set<string>(HERDR_PREFIX_ACTIONS);
  const register = (field: string, values: readonly string[]): void => {
    const isIndexed = Object.hasOwn(INDEXED, field);
    for (const raw of values) {
      const binding = raw.trim() === "" ? null : parseHerdrBinding(raw);
      if (binding === null || (binding.range && !isIndexed)) continue;
      const kept: { chord: HerdrChord; index: number | null }[] = [];
      for (const item of bindingChords(binding, field)) {
        if (isIndexed && !/^[1-9]$/.test(item.chord.key)) continue;
        // a direct binding takes no prefix key: herdr keeps those apart
        if (!binding.prefixed) continue;
        const id = chordId(item.chord);
        if (prefixIds.has(id) || taken.has(id)) continue;
        taken.add(id);
        kept.push(item);
      }
      if (!supported.has(field)) continue;
      const action = field as HerdrPrefixAction;
      if (binding.range && kept.length === 9) bindings[action].push(raw.trim());
      else for (const item of kept) bindings[action].push(binding.range ? raw.trim().replace("1..9", item.chord.key) : raw.trim());
    }
  };
  for (const pass of ["user", "default"] as const) {
    for (const [field, defaults] of FIELDS) {
      const written = Object.hasOwn(user, field);
      if (written !== (pass === "user")) continue;
      // a legacy [keys.indexed] entry is the user's own binding for that action: its default stands down
      if (pass === "default" && Object.hasOwn(INDEXED, field) && typeof indexed?.[INDEXED[field]!] === "string" && (indexed[INDEXED[field]!] as string).trim() !== "") continue;
      register(field, written ? bindingValues(user[field]) ?? [] : [defaults]);
    }
    if (pass === "user" && Array.isArray(commands)) {
      for (const command of commands) {
        const entry = table(command);
        // a command herdr skips (no command to run) takes no key; its body is only checked, never kept
        if (entry === null || typeof entry["command"] !== "string" || entry["command"].trim() === "") continue;
        register("command", bindingValues(entry["key"]) ?? []);
      }
    }
  }
  return { prefix: prefixes[0]!, prefixes, bindings };
}
