import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "jsonc-parser";
import { SkillIgnore } from "../skill-ignore.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

export interface WalkRules {
  readonly depth: "one" | "recursive";
  readonly looseMarkdown: "none" | "root" | "nested";
  readonly ignoreFiles: boolean;
  readonly requireDescription: boolean;
  readonly skipNames?: (name: string) => boolean;
  /** Only when a sibling alias cannot change a skill's name or ignore rules. */
  readonly uniqueFolders?: boolean;
  /** Work remaining, shared by every walk given the same object. */
  readonly budget?: WalkBudget;
}
/** Mutable allowances for one discovery; absent optional ignore files are only probes. */
export interface WalkBudget {
  folders: number;
  entries: number;
  reads: number;
}
// Allows thousands of ordinary skills, including loaders that read metadata and body separately.
export const createWalkBudget = (): WalkBudget => ({ folders: MAX_WALK_FOLDERS, entries: 32768, reads: 4096 });
export interface WalkedSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** the file's canonical (real) path: one file reached through a link has the same id; walkSkills always sets it */
  readonly id?: string;
}

/** The file's real path, links resolved: the `id` of a row read from that file. */
export function canonicalFile(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

// Only blanks may follow the opening `---` on its line: `\s*` there also took newlines, so a header
// left unclosed (a file cut at 64 KiB) was retried at every split of them, quadratic in its length.
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/;

/** The YAML fields of `markdown`'s frontmatter; null without a well-formed header. */
function parseFrontmatter(markdown: string): Readonly<Record<string, unknown>> | null {
  const header = markdown.match(FRONTMATTER)?.[1];
  if (!header) return null;
  try {
    const fields: unknown = Bun.YAML.parse(header);
    return typeof fields === "object" && fields !== null && !Array.isArray(fields) ? Object.fromEntries(Object.entries(fields)) : null;
  } catch { return null; /* malformed YAML */ }
}

// Discovery runs on the server's one thread for every menu: a skill file is read only up to this
// much, and only when it is a regular file (a link to /dev/zero or a huge file would stall it).
const MAX_SKILL_BYTES = 64 * 1024;

// A walk visits at most this many folders. Its link guard covers the current branch only, so sibling
// links to shared folders make an acyclic tree exponential, and discovery runs on the server's thread.
export const MAX_WALK_FOLDERS = 4096;

/**
 * The path checked before it is opened, then the descriptor itself: a FIFO swapped in between would
 * block a plain open, so it opens non-blocking (a regular file ignores the flag) and is refused there.
 */
function openRegular(path: string): number {
  if (!statSync(path).isFile()) throw new Error(`not a regular file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0));
  let regular = false;
  try { regular = fstatSync(fd).isFile(); } finally { if (!regular) closeSync(fd); }
  if (!regular) throw new Error(`not a regular file: ${path}`);
  return fd;
}

/** A config file read whole, only when it is a regular file of at most `maxBytes`; throws otherwise (a FIFO is never waited on). */
export function readConfigText(path: string, maxBytes = 1024 * 1024): string {
  const fd = openRegular(path);
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (let count = 1; count > 0 && length < buffer.length; length += count) count = readSync(fd, buffer, length, buffer.length - length, null);
    if (length > maxBytes) throw new Error(`config file over ${maxBytes} bytes: ${path}`);
    return buffer.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

/** The first MAX_SKILL_BYTES of a regular file; throws when `path` is no regular file. */
export function readSkillText(path: string, budget?: WalkBudget): string {
  if (budget) {
    if (budget.reads <= 0) throw new Error("skill read budget exhausted");
    budget.reads -= 1;
  }
  const fd = openRegular(path);
  try {
    const buffer = Buffer.alloc(MAX_SKILL_BYTES);
    let length = 0;
    for (let count = 1; count > 0 && length < buffer.length; length += count) count = readSync(fd, buffer, length, buffer.length - length, null);
    return buffer.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

/** Reads only through the closing frontmatter delimiter, without reading the skill body. */
export function readFrontmatter(path: string, budget?: WalkBudget): Readonly<Record<string, unknown>> | null {
  if (budget) {
    if (budget.reads <= 0) return null;
    budget.reads -= 1;
  }
  try {
    const fd = openRegular(path);
    let markdown = "";
    try {
      // one buffer, bounded: a header longer than MAX_SKILL_BYTES is no frontmatter
      const buffer = Buffer.alloc(MAX_SKILL_BYTES);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, Math.min(8192, buffer.length - length), null);
        if (count === 0) break;
        length += count;
        markdown = buffer.subarray(0, length).toString("utf8");
        if (!markdown.startsWith("---") && !markdown.startsWith("\uFEFF---")) return null;
        if (/\r?\n---(?:\s*\r?\n|$)/.test(markdown)) break;
      }
    } finally { closeSync(fd); }
    return parseFrontmatter(markdown);
  } catch { return null; /* missing or unreadable */ }
}

/**
 * A command's description, whole: the frontmatter's `description` as YAML reads it (a `>-` or `|`
 * block scalar included), else the `description:` line as written, else the body's first non-empty
 * line. Agents read a header that is not strict YAML (an unquoted colon, `argument-hint: [a] [b]`)
 * line by line, so a header YAML refuses still yields its description line. The menu shortens it
 * to one sentence itself and shows the whole text in the row's tooltip, so nothing is cut here.
 */
export function description(markdown: string): string {
  const frontmatter = markdown.match(FRONTMATTER);
  const found = parseFrontmatter(markdown)?.description;
  const raw = frontmatter?.[1]?.match(/^description:[ \t]*(.+?)\s*$/m)?.[1]?.trim();
  // a block scalar's indicator alone is no description: its text is on the lines below it
  const line = raw && !/^[>|][-+]?\d?$/.test(raw) ? raw.replace(/^(["'])(.*)\1$/, "$2") : undefined;
  // YAML takes ` #` in a plain value as a comment (`Issue #102 ...` reads as `Issue`); the line
  // as written is what the person meant there, and what the line-reading loaders showed before
  if (typeof found === "string" && found.trim()) return line && !/^["']/.test(raw!) && line.length > found.trim().length && line.startsWith(found.trim()) ? line : found.trim();
  if (line) return line;
  const body = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
  return body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

/** `name:` from a SKILL.md's frontmatter, else its directory's name. */
function skillName(markdown: string, directory: string): string {
  const frontmatter = markdown.match(FRONTMATTER);
  const named = frontmatter?.[1]?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return named && /^[\p{L}\p{N}_:-]+$/u.test(named) ? named : directory;
}
export function walkSkills(root: string, rules: WalkRules): WalkedSkill[] {
  const result: WalkedSkill[] = [];
  for (const skill of walkSkillSteps(root, rules)) if (skill) result.push(skill);
  return result;
}

/** Resumable work checkpoints let multiple roots share one allowance without rescanning. */
export function* walkSkillSteps(root: string, rules: WalkRules): Generator<WalkedSkill | null> {
  const budget = rules.budget ?? createWalkBudget();
  if (budget.folders <= 0 || budget.entries <= 0 || budget.reads <= 0) return;
  const ignore = new SkillIgnore();
  const ancestors = new Set<string>();
  const visited = rules.uniqueFolders ? new Set<string>() : null;
  const load = (path: string): WalkedSkill | null => {
    const fields = readFrontmatter(path, budget) ?? {};
    if (rules.requireDescription && (typeof fields.description !== "string" || !fields.description.trim())) return null;
    try {
      // The original one-level loaders use their permissive name parser and short body fallback.
      const markdown = rules.requireDescription ? "" : readSkillText(path, budget);
      const name = rules.requireDescription
        ? typeof fields.name === "string" && fields.name ? fields.name : basename(dirname(path))
        : skillName(markdown, basename(dirname(path)));
      return { name, description: rules.requireDescription && typeof fields.description === "string" ? fields.description : description(markdown), path, fields, id: canonicalFile(path) };
    } catch { return null; /* unreadable skill */ }
  };
  if (rules.depth === "one") {
    yield null;
    if (budget.folders <= 0 || budget.entries <= 0 || budget.reads <= 0) return;
    budget.folders -= 1;
    if (!existsSync(root)) return;
    if (rules.ignoreFiles) {
      for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
        if (budget.reads <= 0) return;
        budget.reads -= 1;
        try { ignore.add(readFileSync(join(root, filename), "utf8")); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") budget.reads += 1;
        }
      }
    }
    if (budget.entries <= 0 || budget.reads <= 0) return;
    const found = readdirSync(root, { withFileTypes: true });
    const entries = found.slice(0, budget.entries);
    budget.entries -= found.length;
    for (let index = 0; index < entries.length; index++) yield null;
    for (const entry of entries) {
      if (budget.reads <= 0) break;
      if (entry.name.startsWith(".") || rules.skipNames?.(entry.name)) continue;
      const directory = join(root, entry.name);
      try {
        if (statSync(directory).isDirectory() && !ignore.ignores(entry.name + "/")) yield load(join(directory, "SKILL.md"));
        else if (rules.looseMarkdown === "root" && entry.name.endsWith(".md") && statSync(directory).isFile() && !ignore.ignores(entry.name)) yield load(directory);
      } catch { continue; /* broken links or missing skill */ }
    }
    return;
  }
  function* visit(directory: string): Generator<WalkedSkill | null> {
    // every visit counts, a link back to an ancestor too: each one is a lookup on the server's thread
    yield null;
    if (budget.folders <= 0 || budget.entries <= 0 || budget.reads <= 0) return;
    budget.folders -= 1;
    let canonical: string;
    try { canonical = realpathSync(directory); } catch { return; }
    if (ancestors.has(canonical) || visited?.has(canonical)) return;
    ancestors.add(canonical);
    try {
      const prefix = relative(root, directory).split(sep).join("/");
      for (const filename of rules.ignoreFiles ? [".gitignore", ".ignore", ".fdignore"] : []) {
        if (budget.reads <= 0) return;
        budget.reads -= 1;
        try { ignore.add(readFileSync(join(directory, filename), "utf8"), prefix ? `${prefix}/` : ""); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") budget.reads += 1;
          continue;
        }
      }
      if (budget.entries <= 0 || budget.reads <= 0) return;
      // readdir is atomic: charge its whole array before suspending, even the unprocessed tail.
      const found = readdirSync(directory, { withFileTypes: true });
      const entries = found.slice(0, budget.entries);
      budget.entries -= found.length;
      for (let index = 0; index < entries.length; index++) yield null;
      const declared = join(directory, "SKILL.md");
      if (entries.some((entry) => entry.name === "SKILL.md") && !ignore.ignores(relative(root, declared).split(sep).join("/"))) {
        try {
          if (statSync(declared).isFile()) {
            const skill = load(declared);
            // A missing name falls back to this alias's directory, so those rows stay distinct.
            if (rules.requireDescription && skill && typeof skill.fields.name === "string" && skill.fields.name) visited?.add(canonical);
            yield skill;
            return;
          }
        } catch { /* a broken SKILL.md link does not hide other entries */ }
      }
      visited?.add(canonical);
      for (const entry of entries) {
        if (budget.reads <= 0) break;
        if (entry.name.startsWith(".") || entry.name === "node_modules" || rules.skipNames?.(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          const relativePath = relative(root, path).split(sep).join("/");
          if (ignore.ignores(relativePath + (target.isDirectory() ? "/" : ""))) continue;
          if (target.isDirectory()) yield* visit(path);
          else if (target.isFile() && entry.name.endsWith(".md") && (rules.looseMarkdown === "root" ? directory === root : rules.looseMarkdown === "nested" && directory !== root)) yield load(path);
        } catch { continue; /* broken links and unreadable directories are skipped */ }
      }
    } finally { ancestors.delete(canonical); }
  }
  yield* visit(root);
}

/** Existing one-level command mapping, kept separate from each agent's root selection. */
/** A process environ block (`NAME=value` lines) as a record; entries without `=` are skipped. */
export function environRecord(env: readonly string[] | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of env ?? []) {
    const equal = entry.indexOf("=");
    if (equal > 0) result[entry.slice(0, equal)] = entry.slice(equal + 1);
  }
  return result;
}

/** One variable of a process environ block; unset and empty both read as undefined. */
export function environValue(env: readonly string[] | null | undefined, name: string): string | undefined {
  return env?.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) || undefined;
}

/** A parsed config value as a plain record; anything else is empty. */
export function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** The pinned OmO loader removes one leading BOM, then parses JSONC with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  const contents = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const errors: { error: number; length: number; offset: number }[] = [];
  const value = parse(contents, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) throw new SyntaxError("Invalid JSONC");
  return value;
}

/** `budget`: work remaining, shared across skill and command roots in one discovery. */
export function customCommands(root: string, source: SlashCommand["source"], budget = createWalkBudget(), include?: (fields: Readonly<Record<string, unknown>>) => boolean): SlashCommand[] {
  const result: SlashCommand[] = [];
  for (const command of customCommandSteps(root, source, budget, include)) if (command) result.push(command);
  return result;
}

/** `sortByName` matches Node's UTF-8-byte-sorted readdir, with the same depth-first traversal. */
export function* customCommandSteps(root: string, source: SlashCommand["source"], budget = createWalkBudget(), include?: (fields: Readonly<Record<string, unknown>>) => boolean, sortByName = false): Generator<SlashCommand | null> {
  if (budget.folders <= 0 || budget.entries <= 0 || budget.reads <= 0) return;
  // Guard only the current ancestry: sibling links can expose different command namespaces.
  const ancestors = new Set<string>();
  function* visit(directory: string): Generator<SlashCommand | null> {
    // every visit counts, a link back to an ancestor too: each one is a lookup on the server's thread
    yield null;
    if (budget.folders <= 0 || budget.entries <= 0 || budget.reads <= 0) return;
    budget.folders -= 1;
    let canonical: string;
    try { canonical = realpathSync(directory); } catch { return; }
    if (ancestors.has(canonical)) return;
    ancestors.add(canonical);
    try {
      let found: Dirent[];
      try { found = readdirSync(directory, { withFileTypes: true }); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOTDIR") return;
        throw error;
      }
      if (sortByName) found = found.map((entry) => ({ entry, bytes: Buffer.from(entry.name) }))
        .sort((left, right) => Buffer.compare(left.bytes, right.bytes)).map(({ entry }) => entry);
      const entries = found.slice(0, budget.entries);
      budget.entries -= found.length;
      for (let index = 0; index < entries.length; index++) yield null;
      for (const entry of entries) {
        if (budget.reads <= 0) break;
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          if (target.isDirectory()) yield* visit(path);
          else if (target.isFile() && entry.name.endsWith(".md")) {
            const markdown = readSkillText(path, budget);
            // Finish visibility filtering from this read before spending the next allowance.
            if (include && !include(parseFrontmatter(markdown) ?? {})) continue;
            const relativeName = relative(root, path).slice(0, -3).split(sep).join(":");
            yield { name: relativeName, description: description(markdown), source, id: canonicalFile(path) };
          }
        } catch { continue; }
      }
    } finally { ancestors.delete(canonical); }
  }
  yield* visit(root);
}


/**
 * Templates are commands. A conventional prompt directory holds direct `.md` children only —
 * pi reads no deeper there, so recursing would offer commands pi never loads.
 *
 * A link is asked of what it points at, not of itself: pi stats the entry, so a `.md` reached
 * through a symlink is a template it loads, and a directory is not one however the link is named.
 */
export function piTemplates(root: string, source: SlashCommand["source"]): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let markdown: string;
    try {
      // the target is what gets read, so the target is what gets asked: a broken link throws here
      // and is skipped, as pi skips it, and a link to a folder fails isFile however it is named.
      // One path for links and plain files alike — the stat costs less than the read that follows
      // and keeps the two from being judged by different rules
      markdown = readSkillText(join(root, entry.name));
    } catch {
      continue;
    }
    result.push({ name: entry.name.slice(0, -3), description: description(markdown), source, id: canonicalFile(join(root, entry.name)) });
  }
  return result;
}


/** The nearest repository boundary wins; the home directory is never a project ancestor. */
export function ancestorsToRepoRoot(cwd: string): string[] {
  const start = resolve(cwd);
  const home = resolve(process.env.HOME ?? "");
  if (start === home || home.startsWith(start.endsWith(sep) ? start : start + sep)) return [];
  const result: string[] = [];
  for (let directory = start; directory !== home && directory !== dirname(directory); directory = dirname(directory)) {
    result.push(directory);
    if (existsSync(join(directory, ".git"))) return result;
  }
  return [cwd];
}
