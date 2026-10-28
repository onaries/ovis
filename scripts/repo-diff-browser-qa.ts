/**
 * The repository diff viewer (Files → Changes → RepoDiffViewer) in the built app, against real git
 * repositories answered by the server's own repo-diff module: the changed files of the working
 * tree, the index and two commits with their statuses; a 10 000-line diff as a bounded window of
 * rows, unified and split, at the top, the middle and the end; the layout setting kept across a
 * reload and declined on a phone; the context folded and shown again with the line numbers kept;
 * native selection and a real copy that keep blank lines and leave the gutters out; binary,
 * too-large, conflicted, deleted, untracked and renamed files and their notes; a folder that is no
 * repository and a commit that does not exist; the file itself opened on the owning PC; Escape,
 * Back and Close with the focus returned; a remote PC's routes; the rows in the app's palette; Find
 * in the 10 000-line diff (folded context at the top, the middle and the end, both sides, split and
 * wrap, Escape order, and a loading, refused, offline or watch-only patch with nothing to search);
 * the Branch scope against a chosen base (the picker's refs, typed and picked bases, the list from
 * the merge base with untracked files, a patch pinned to that merge base while the base moves on,
 * the refresh a moved HEAD asks for, and every refusal: an unknown base, unrelated histories, no
 * commit yet, a watching device, a bridge too old for it); and the static demo's fixture.
 *
 * The browser is Playwright's headless shell, whose clipboard is its own: a real Cmd+C here never
 * touches the clipboard of the PC running the check.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { build as viteBuild } from "vite";
import { repoDiffResponse } from "../server/repo-diff.ts";
import { serveStatic } from "../server/static.ts";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import { KO as KO_TEXT } from "../src/lib/i18n.ko.ts";

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

const BIG_LINES = 10_000;
/** Rewritten whole, its patch passes the server's 1 MiB cap; the 10 000-line diff stays under it. */
const LARGE_LINES = 8_000;
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-repo-diff-")));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
/** Numbered TypeScript lines, a blank one every tenth; `changed` rewrites every fourth line's comment. */
function numbered(lines: number, changed: boolean): string {
  const out: string[] = [];
  for (let line = 1; line <= lines; line++) {
    if (line % 10 === 0) out.push("");
    else out.push(`export const line_${String(line).padStart(5, "0")} = ${line}; // ${changed && line % 4 === 0 ? "changed" : "numbered"} line ${line}`);
  }
  return `${out.join("\n")}\n`;
}
const MONEY_OLD = ["export type Cents = number;", "", "export function toCents(amount: number): Cents {", "  return amount * 100;", "}", "", "export function fromCents(cents: Cents): number {", "  return cents / 100;", "}", "", "export function add(a: Cents, b: Cents): Cents {", "  return a + b;", "}", "", "export function format(cents: Cents): string {", "  return (cents / 100).toFixed(2);", "}", ""].join("\n");
const MONEY_NEW = MONEY_OLD
  .replace("  return amount * 100;", "  const scaled = Math.abs(amount) * 100;\n  return Math.sign(amount) * Math.round(scaled);")
  .replace("  return (cents / 100).toFixed(2);", "  return `$${(cents / 100).toFixed(2)}`;");

/** `git update-ref --stdin`: many refs made in one process. */
function updateRefs(cwd: string, commands: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, "update-ref", "--stdin"], { stdin: Buffer.from(`${commands.join("\n")}\n`), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git update-ref --stdin failed: ${result.stderr.toString()}`);
}
/** A new commit on `ref` with the same tree, made without touching the checkout: the ref moved on, nothing else did. */
function moveRef(cwd: string, ref: string, message: string): string {
  const tip = git(cwd, "rev-parse", ref).trim();
  const moved = git(cwd, "commit-tree", git(cwd, "rev-parse", `${tip}^{tree}`).trim(), "-p", tip, "-m", message).trim();
  git(cwd, "update-ref", ref, moved);
  return tip;
}
const LONG_BRANCH = "fix/a-very-long-branch-name-that-goes-on-and-on-without-a-break-anywhere-in-it-at-all-until-here";
const LONG_PATH = "src/a-folder-with-a-very-long-name-that-never-breaks/and-another-one-below-it/an-unbroken-file-name-of-some-length.ts";

/** Real repositories and a plain folder, as the panes of the fixture would sit in them. */
function fixtures(): { main: string; detached: string; plain: string; long: string; fork: string; unborn: string; orphan: string; crowded: string } {
  const main = join(root, "repo");
  mkdirSync(join(main, "src"), { recursive: true });
  mkdirSync(join(main, "docs"));
  mkdirSync(join(main, "assets"));
  mkdirSync(join(main, "notes", "dir with space"), { recursive: true });
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "src/big.ts"), numbered(BIG_LINES, false));
  writeFileSync(join(main, "src/money.ts"), MONEY_OLD.replace("export function add", "export function sum"));
  writeFileSync(join(main, "src/gone.ts"), "export const gone = true;\n\nexport const twice = 2;\n");
  writeFileSync(join(main, "src/staged.ts"), "export const staged = 1;\n");
  writeFileSync(join(main, "src/large.txt"), `${"x".repeat(80)}\n`.repeat(LARGE_LINES));
  writeFileSync(join(main, "docs/old-name.md"), "# Notes\n\nthe first paragraph\n\nthe second paragraph\n");
  writeFileSync(join(main, "assets/pic.bin"), new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]));
  writeFileSync(join(main, "notes/dir with space/ünï 文件.txt"), "eins\nzwei\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "first");
  writeFileSync(join(main, "src/money.ts"), MONEY_OLD);
  writeFileSync(join(main, "CHANGELOG.md"), "# Changelog\n\n- money: add\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "second");
  // staged: a rename with an edit, and an edit that is edited again below
  git(main, "mv", "docs/old-name.md", "docs/new-name.md");
  writeFileSync(join(main, "docs/new-name.md"), "# Notes\n\nthe first paragraph, revised\n\nthe second paragraph\n");
  writeFileSync(join(main, "src/staged.ts"), "export const staged = 2;\n");
  git(main, "add", "docs/new-name.md", "src/staged.ts");
  // unstaged
  writeFileSync(join(main, "src/big.ts"), numbered(BIG_LINES, true));
  writeFileSync(join(main, "src/money.ts"), MONEY_NEW);
  writeFileSync(join(main, "src/staged.ts"), "export const staged = 3;\n");
  writeFileSync(join(main, "src/large.txt"), `${"y".repeat(80)}\n`.repeat(LARGE_LINES));
  writeFileSync(join(main, "docs/new-name.md"), "# Notes\n\nthe first paragraph, revised\n\nthe second paragraph, too\n");
  writeFileSync(join(main, "assets/pic.bin"), new Uint8Array([137, 80, 78, 71, 0, 9, 8, 7, 6]));
  writeFileSync(join(main, "notes/dir with space/ünï 文件.txt"), "eins\ndrei\n");
  writeFileSync(join(main, "src/new.ts"), "export const fresh = 1;\n\nexport const minted = 2;\n");
  rmSync(join(main, "src/gone.ts"));

  const detached = join(root, "conflict");
  mkdirSync(join(detached, "src"), { recursive: true });
  git(detached, "init", "-q", "-b", "main");
  writeFileSync(join(detached, "src/conflict.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(detached, "add", ".");
  git(detached, "commit", "-q", "-m", "base");
  git(detached, "checkout", "-q", "-b", "feature");
  writeFileSync(join(detached, "src/conflict.ts"), "export const a = 1;\nexport const b = 20;\n");
  git(detached, "commit", "-q", "-am", "feature");
  git(detached, "checkout", "-q", "--detach", "main");
  writeFileSync(join(detached, "src/conflict.ts"), "export const a = 1;\nexport const b = 200;\n");
  git(detached, "commit", "-q", "-am", "main side");
  const merge = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", detached, "merge", "feature"], { stdout: "pipe", stderr: "pipe" });
  assert.notEqual(merge.exitCode, 0, "the merge conflicts");

  const plain = join(root, "plain");
  mkdirSync(plain);

  // one line longer than any screen, its match 600 characters in, beside a short one; below it an
  // unchanged line that wraps taller than any view, its match at the very end
  const long = join(root, "long");
  mkdirSync(join(long, "src"), { recursive: true });
  git(long, "init", "-q", "-b", "main");
  const tall = `export const tall = "${"word ".repeat(3000)}haystack";\n`;
  writeFileSync(join(long, "src/long.ts"), `export const short = 1;\nexport const wide = "${"x".repeat(600)} old";\n${tall}`);
  git(long, "add", ".");
  git(long, "commit", "-q", "-m", "long");
  writeFileSync(join(long, "src/long.ts"), `export const short = 1;\nexport const wide = "${"x".repeat(600)} needle";\n${tall}`);

  // a branch forked from main, which went on without it: base-only commits, branch commits, staged
  // and unstaged work, a rename, untracked text and binary files, local and remote branches
  const fork = join(root, "fork");
  mkdirSync(join(fork, "src"), { recursive: true });
  mkdirSync(join(fork, "docs"));
  mkdirSync(join(fork, "assets"));
  mkdirSync(join(fork, LONG_PATH.slice(0, LONG_PATH.lastIndexOf("/"))), { recursive: true });
  git(fork, "init", "-q", "-b", "main");
  writeFileSync(join(fork, "src/shared.ts"), ["export const one = 1;", "export const two = 2;", "export const three = 3;", "export const four = 4;", "export const five = 5;", "export const six = 6;", ""].join("\n"));
  writeFileSync(join(fork, "src/gone.ts"), "export const gone = true;\n");
  // long enough that one revised line still reads as a rename (git's similarity is by content)
  writeFileSync(join(fork, "docs/old-name.md"), "# Notes\n\nthe first paragraph\n\nthe second paragraph\n\nthe third paragraph\n\nthe fourth paragraph\n");
  writeFileSync(join(fork, "README.md"), "# checkout-api\n");
  writeFileSync(join(fork, LONG_PATH), "export const deep = 1;\n");
  git(fork, "add", ".");
  git(fork, "commit", "-q", "-m", "fork point");
  git(fork, "checkout", "-q", "-b", "feat/idempotent-payments");
  writeFileSync(join(fork, "src/routes.ts"), "export const routes = ['/payments'];\n");
  git(fork, "add", ".");
  git(fork, "commit", "-q", "-m", "branch work");
  git(fork, "checkout", "-q", "main");
  writeFileSync(join(fork, "README.md"), "# checkout-api\n\nthe base moved on\n");
  writeFileSync(join(fork, "src/shared.ts"), ["export const one = 'base edit';", "export const two = 2;", "export const three = 3;", "export const four = 4;", "export const five = 5;", "export const six = 6;", ""].join("\n"));
  git(fork, "commit", "-q", "-a", "-m", "base moves on");
  git(fork, "checkout", "-q", "feat/idempotent-payments");
  git(fork, "mv", "docs/old-name.md", "docs/new-name.md");
  writeFileSync(join(fork, "docs/new-name.md"), "# Notes\n\nthe first paragraph, revised\n\nthe second paragraph\n\nthe third paragraph\n\nthe fourth paragraph\n");
  git(fork, "add", "docs/new-name.md");
  writeFileSync(join(fork, "src/shared.ts"), ["export const one = 1;", "export const two = 2;", "export const three = 3;", "export const four = 4;", "export const five = 5;", "export const six = 'branch edit';", ""].join("\n"));
  writeFileSync(join(fork, LONG_PATH), "export const deep = 2;\n");
  rmSync(join(fork, "src/gone.ts"));
  writeFileSync(join(fork, "src/untracked.ts"), "export const fresh = 1;\n\nexport const minted = 2;\n");
  writeFileSync(join(fork, "assets/blob.bin"), new Uint8Array([1, 0, 2, 0]));
  for (const name of ["release/2026.10", LONG_BRANCH]) git(fork, "branch", name, "main");
  git(fork, "update-ref", "refs/remotes/origin/main", "main");
  git(fork, "update-ref", "refs/remotes/origin/feat/idempotent-payments", "feat/idempotent-payments");
  git(fork, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

  // no commit yet: nothing to compare a branch from, and no branch to offer
  const unborn = join(root, "unborn");
  mkdirSync(unborn);
  git(unborn, "init", "-q", "-b", "main");

  // two histories that share nothing
  const orphan = join(root, "orphan");
  mkdirSync(orphan);
  git(orphan, "init", "-q", "-b", "main");
  writeFileSync(join(orphan, "a.txt"), "one\n");
  git(orphan, "add", ".");
  git(orphan, "commit", "-q", "-m", "main");
  git(orphan, "checkout", "-q", "--orphan", "island");
  writeFileSync(join(orphan, "b.txt"), "two\n");
  git(orphan, "add", ".");
  git(orphan, "commit", "-q", "-m", "island");

  // more branches than the picker lists
  const crowded = join(root, "crowded");
  mkdirSync(crowded);
  git(crowded, "init", "-q", "-b", "main");
  writeFileSync(join(crowded, "a.txt"), "one\n");
  git(crowded, "add", ".");
  git(crowded, "commit", "-q", "-m", "first");
  const first = git(crowded, "rev-parse", "HEAD").trim();
  updateRefs(crowded, Array.from({ length: 210 }, (_, index) => `create refs/heads/many/${String(index).padStart(3, "0")} ${first}`));
  return { main, detached, plain, long, fork, unborn, orphan, crowded };
}

const repos = fixtures();
const workspace = join(root, "workspace");
mkdirSync(workspace);
writeFileSync(join(root, "external.log"), "external file content\n");
git(workspace, "init", "-q", "-b", "main");
const backend = join(workspace, "backend");
mkdirSync(join(backend, "server"), { recursive: true });
git(backend, "init", "-q", "-b", "main");
writeFileSync(join(backend, "server/test_out_work.py"), "assert old_result\n");
git(backend, "add", ".");
git(backend, "commit", "-q", "-m", "nested backend");
git(workspace, "add", "backend");
git(workspace, "commit", "-q", "-m", "workspace");
writeFileSync(join(backend, "server/test_out_work.py"), "assert changed_result\n");
const panes = new Map([["pane-main", repos.main], ["pane-conflict", repos.detached], ["pane-plain", repos.plain], ["pane-nested", workspace]]);
const discovery = join(root, "discovery");
const deepRoots = [1, 2, 3, 4].map((depth) => {
  const path = join(discovery, ...Array.from({ length: depth }, () => "level"));
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  return path;
});
panes.set("pane-discovery", discovery);
panes.set("pane-long", repos.long);
panes.set("pane-fork", repos.fork);
panes.set("pane-unborn", repos.unborn);
panes.set("pane-orphan", repos.orphan);
panes.set("pane-crowded", repos.crowded);
panes.set("pane-observe", repos.fork);
panes.set("pane-old", repos.fork);
panes.set("pane-offline", repos.fork);
const requests: string[] = [];
/** a patch request for `pane-held` waits on this until the check lets it through */
let held = Promise.withResolvers<void>();
/** each diff route's path with its query: which target and scope a read was for */
const diffQueries: string[] = [];
/** the query of each branch patch read: what identity the viewer carried back */
const branchPatches: URLSearchParams[] = [];
/** a PC whose branch list is held until released: a switch to another PC must not take its late answer */
let branchHeld: { promise: Promise<void>; release: () => void } | null = null;
/** one route of pane-fork held for a loading capture: `reached` settles once the request is in */
let hold: { kind: "files" | "file" | "refs"; reached: () => void; gate: Promise<void> } | null = null;
function holdNext(kind: "files" | "file" | "refs"): { reached: Promise<void>; release: () => void } {
  let open = (): void => {};
  let arrived = (): void => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const reached = new Promise<void>((resolve) => { arrived = resolve; });
  hold = { kind, reached: arrived, gate };
  return { reached, release: () => { hold = null; open(); } };
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let demoServer: ReturnType<typeof Bun.serve> | undefined;

/** The route the real server gives these paths, on a stand-in that maps a pane to its folder. */
async function api(request: Request, url: URL): Promise<Response | null> {
  const diff = /^\/api\/(?:machines\/([^/]+)\/)?workspace\/diff\/(files|file|repositories|refs)$/.exec(url.pathname);
  if (diff) {
    requests.push(url.pathname);
    diffQueries.push(`${url.pathname}?${url.searchParams}`);
    const paneId = url.searchParams.get("pane_id");
    const kind = diff[2] as "files" | "file" | "repositories" | "refs";
    // a device that may only watch is refused as the server refuses it, before any repository is read
    if (paneId === "pane-observe") return Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 });
    // a bridge from before the branch scope: no refs route, and a scope it does not know
    if (paneId === "pane-old" && kind === "refs") return Response.json({ error: { code: "not_found", message: "unknown endpoint /api/workspace/diff/refs" } }, { status: 404 });
    if (paneId === "pane-old" && url.searchParams.get("scope") === "branch") return Response.json({ error: { code: "invalid_scope", message: "scope must be workspace, staged or commit" } }, { status: 400 });
    // a PC that is offline: its bridge answers nothing, as the machine proxy says
    if (paneId === "pane-offline") return Response.json({ error: { code: "machine_offline", message: "that PC is offline" } }, { status: 503 });
    if (hold !== null && hold.kind === kind && paneId === "pane-fork") { const current = hold; current.reached(); await current.gate; }
    // the slow PC answers its branches from the crowded repository, once released
    if (diff[1] === "slow-fixture" && kind === "refs") {
      if (branchHeld) await branchHeld.promise;
      return repoDiffResponse("refs", repos.crowded, url.searchParams);
    }
    if (kind === "file" && url.searchParams.get("scope") === "branch") branchPatches.push(url.searchParams);
    const base = paneId !== null ? panes.get(paneId) : undefined;
    const directory = url.searchParams.get("directory");
    const cwd = directory ? (isAbsolute(directory) ? directory : resolve(base ?? root, directory)) : base;
    // a PC that is offline, a device that may only watch, and a patch held on its way, each as the real routes answer
    if (diff[1] === "offline-pc") return Response.json({ error: { code: "machine_offline", message: "that PC is offline" } }, { status: 503 });
    if (paneId === "pane-watch") return Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 });
    if (paneId === "pane-held") { await held.promise; return repoDiffResponse(diff[2] === "files" ? "files" : "file", repos.main, url.searchParams); }
    if (!cwd) return Response.json({ error: { code: "pane_not_found", message: "no such pane" } }, { status: 404 });
    return repoDiffResponse(kind, cwd, url.searchParams);
  }
  const fs = /^\/api\/(?:machines\/([^/]+)\/)?fs\/(stat|file)$/.exec(url.pathname);
  if (fs) {
    requests.push(url.pathname);
    const input = url.searchParams.get("path") ?? "";
    const path = resolve(panes.get(url.searchParams.get("pane_id") ?? "") ?? root, input);
    let size: number;
    try { size = statSync(path).size; } catch { return Response.json({ error: { code: "not_found", message: "No readable file at this path." } }, { status: 404 }); }
    if (fs[2] === "stat") return Response.json({ path, name: path.split("/").pop(), kind: "text", size, mime: "text/plain", modified: "2026-01-01T00:00:00Z" });
    const body = readFileSync(path);
    const range = /^bytes=0-(\d+)$/.exec(request.headers.get("range") ?? "");
    if (range && Number(range[1]) < body.byteLength - 1) {
      const end = Number(range[1]);
      return new Response(body.subarray(0, end + 1), { status: 206, headers: { "content-range": `bytes 0-${end}/${body.byteLength}`, "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (/^\/api\/(?:machines\/[^/]+\/)?workspace\/directories$/.test(url.pathname)) {
    const path = url.searchParams.get("path") || repos.main;
    return Response.json({ path, parent: null, home: root, directories: [], files: [], truncated: false });
  }
  return null;
}

/** The diff's rows in its shadow DOM, a self-contained reader serialized into each `evaluate`. */
const diffRows = () => Array.from(document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []);

/** The words the controls go by, in English and in Korean (the one capture of every new string). */
const EN = { files: "Files", changes: "Changes", branch: "Branch", base: "Base branch", choose: "Choose a branch", compare: "Compare", refresh: "Refresh changes", closeDiff: "Close diff" };
const KO: typeof EN = { files: "파일", changes: "변경 사항", branch: "브랜치", base: "기준 브랜치", choose: "브랜치 선택", compare: "비교", refresh: "변경 사항 새로 고침", closeDiff: "비교 닫기" };
type Words = typeof EN;
async function openFiles(page: Page, paneId: string, machine = "local", words: Words = EN): Promise<void> {
  await page.evaluate(([paneId, machine, directory]) => window.repoDiffQA.openFiles(machine, paneId, directory), [paneId, machine, panes.get(paneId) ?? "/nowhere"] as const);
  await page.getByRole("dialog", { name: words.files, exact: true }).waitFor();
  await page.getByRole("button", { name: words.changes, exact: true }).click();
}
async function closeFiles(page: Page, words: Words = EN): Promise<void> {
  await page.evaluate(() => window.repoDiffQA.closeFiles());
  await page.getByRole("dialog", { name: words.files, exact: true }).waitFor({ state: "detached" });
}
/** The Changes list once it has answered for `scope`: its rows as `mark path counts`. */
async function changeRows(page: Page, scope = "workspace"): Promise<string[]> {
  const list = page.locator(`.repo-changes:not([aria-busy='true']) .repo-changes-list[data-scope='${scope}']`);
  await list.waitFor();
  return list.locator(".repo-change").evaluateAll((rows) => rows.map((row) => `${row.querySelector(".repo-change-mark")?.textContent} ${row.querySelector(".repo-change-path")?.textContent} ${row.querySelector(".repo-change-counts")?.textContent ?? ""}`.trim()));
}
async function openChange(page: Page, path: string): Promise<void> {
  await page.locator(".repo-change").filter({ has: page.locator(".repo-change-path", { hasText: path }) }).first().click();
  await page.locator(".repo-diff-viewer").waitFor();
}
async function closeDiff(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close diff", exact: true }).click();
  await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
}
/** Waits for the diff's rows; a wait that runs out says what the viewer shows instead. */
async function waitRows(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => (document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
  } catch (error) {
    const seen = await page.evaluate(() => {
      const body = document.querySelector(".repo-diff-body");
      const container = document.querySelector("diffs-container");
      return { body: body?.textContent?.slice(0, 300), html: body?.innerHTML.slice(0, 600), containers: document.querySelectorAll("diffs-container").length, shadow: container?.shadowRoot?.innerHTML.slice(0, 600) };
    });
    throw new Error(`the diff's rows never mounted: ${JSON.stringify(seen)}`, { cause: error });
  }
}
interface Mounted { rows: number; first: number; last: number; inView: number; nodes: number; style: string | null }
async function mounted(page: Page): Promise<Mounted> {
  return page.evaluate(([rowsSource]) => {
    const rows = (new Function(`return (${rowsSource})()`) as () => HTMLElement[])();
    const view = document.querySelector<HTMLElement>(".repo-diff-scroll")!.getBoundingClientRect();
    const lines = rows.map((row) => Number(row.dataset["line"] ?? row.dataset["altLine"])).filter((line) => Number.isFinite(line));
    const inView = rows.filter((row) => { const rect = row.getBoundingClientRect(); return rect.bottom > view.top && rect.top < view.bottom; }).length;
    const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
    return { rows: rows.length, first: Math.min(...lines), last: Math.max(...lines), inView, nodes: shadow.querySelectorAll("*").length, style: shadow.querySelector("pre")?.getAttribute("data-diff-type") ?? null };
  }, [diffRows.toString()] as const);
}
async function scrollDiff(page: Page, where: "top" | "middle" | "end"): Promise<void> {
  await page.evaluate((where) => {
    const scroll = document.querySelector<HTMLElement>(".repo-diff-scroll")!;
    scroll.scrollTop = where === "end" ? scroll.scrollHeight : where === "middle" ? Math.floor(scroll.scrollHeight / 2) : 0;
  }, where);
}
/** Waits for a row at or past `line` to mount after a scroll; a wait that runs out reports the scroll root and the rows. */
async function rowReached(page: Page, line: number, step: string): Promise<void> {
  try {
    await page.waitForFunction((line) => [...(document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? [])].some((row) => Number(row.dataset["line"] ?? row.dataset["altLine"]) >= line), line);
  } catch (error) {
    const seen = await page.evaluate(([rowsSource]) => {
      const rows = (new Function(`return (${rowsSource})()`) as () => HTMLElement[])();
      const lines = rows.map((row) => Number(row.dataset["line"] ?? row.dataset["altLine"]));
      const scroll = document.querySelector<HTMLElement>(".repo-diff-scroll");
      return { rows: rows.length, first: Math.min(...lines), last: Math.max(...lines), scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight, clientHeight: scroll?.clientHeight, overflow: scroll && getComputedStyle(scroll).overflowY };
    }, [diffRows.toString()] as const);
    throw new Error(`${step}: no row at or past ${line} mounted: ${JSON.stringify(seen)}`, { cause: error });
  }
}
/** The viewer's note once it has settled: never the "Opening…" it shows while the patch is read. */
async function note(page: Page): Promise<string> {
  const text = page.locator(".repo-diff-body .repo-diff-note").filter({ hasNotText: "Opening…" });
  await text.waitFor();
  return (await text.textContent()) ?? "";
}
async function shot(page: Page, name: string): Promise<void> {
  if (evidence) await page.screenshot({ path: join(evidence, `repo-diff-${name}.png`), animations: "disabled" });
}
/** The Branch scope's captures, named `branch-review-<width>-<theme>[-ko][-<state>].png` as the visual QA reads them. */
async function branchShot(page: Page, name: string): Promise<void> {
  if (evidence) await page.screenshot({ path: join(evidence, `branch-review-${name}.png`) });
}
/** The base picker's rows, once the list has answered (its loading note gone). */
async function refRows(page: Page): Promise<string[]> {
  const list = page.locator(".repo-changes-refs:not([aria-busy='true'])");
  await list.waitFor();
  return list.locator("[role='option'] .menu-item-main").allTextContents();
}
/** The base picker's note (loading, none, none matching, cut short, refused), once the list has answered. */
async function refNote(page: Page): Promise<string> {
  const note = page.locator(".repo-changes-refs:not([aria-busy='true']) .repo-changes-refs-note").last();
  await note.waitFor();
  return (await note.textContent()) ?? "";
}
/** The scope buttons' pressed transition has ended: a capture mid-way would show two of them lit. */
async function scopesSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.backgroundColor = "var(--bg-hover)";
    const pressed = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [...document.querySelectorAll(".repo-changes-scopes button")].every((button) => (button.getAttribute("aria-pressed") === "true") === (getComputedStyle(button).backgroundColor === pressed));
  });
}
/** The identity line under the repository line: the merge base a branch comparison was read from. */
async function identityLine(page: Page): Promise<string> {
  const line = page.locator(".repo-changes-identity");
  await line.waitFor();
  return (await line.textContent()) ?? "";
}
/** The rows of the diff open now, by type. */
async function rowTexts(page: Page): Promise<{ deletions: string[]; additions: string[] }> {
  return page.evaluate(() => {
    const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
    const texts = (type: string) => [...shadow.querySelectorAll<HTMLElement>(`[data-line][data-line-type='${type}']`)].map((row) => row.textContent?.trim() ?? "");
    return { deletions: texts("change-deletion"), additions: texts("change-addition") };
  });
}

/**
 * The Branch scope end to end, in one language: its picker (the branches, a filter, the keyboard, a
 * typed name), the list from the merge base with the branch's own work and untracked files and
 * none of the base's, the untracked patch, the patch pinned while the base moves on, the refresh a
 * moved HEAD asks for, the same from a detached HEAD, and every refusal in the app's words.
 */
async function branchReview(page: Page, label: string, width: 390 | 1440, theme: "dark" | "light", words: Words): Promise<void> {
  const ko = words === KO;
  const tag = `${width}-${theme}${ko ? "-ko" : ""}`;
  const phone = width === 390;
  const shoot = (state: string) => branchShot(page, `${tag}-${state}`);
  const t = (en: string): string => (ko ? KO_TEXT[en] ?? en : en);
  const compare = page.getByRole("button", { name: words.compare, exact: true });
  const choose = page.getByRole("button", { name: words.choose, exact: true });
  const base = page.getByRole("combobox", { name: words.base, exact: true });
  const expectedRows = [
    "? assets/blob.bin",
    "R docs/old-name.md \u2192 docs/new-name.md +1\u22121",
    `M ${LONG_PATH} +1\u22121`,
    "D src/gone.ts +0\u22121",
    "A src/routes.ts +1\u22120",
    "M src/shared.ts +1\u22121",
    "? src/untracked.ts",
  ];
  const refreshRequired = t("HEAD or the repository changed since the list was read; refresh the list.");

  await openFiles(page, "pane-fork", "local", words);
  await changeRows(page);
  await page.getByRole("button", { name: words.branch, exact: true }).click();
  await scopesSettled(page);
  assert.equal(await compare.isDisabled(), true, `${label}: Compare waits for a base`);
  assert.equal(await page.locator(".repo-changes-list[data-scope]").count(), 0, `${label}: nothing is compared before Compare`);
  assert.equal(await page.locator(".repo-changes-list .repo-changes-note").textContent(), t("Choose a base, then Compare."), `${label}: the list says what it waits for`);
  assert.equal(await page.locator(".repo-changes[aria-busy='true'], .repo-changes-loading").count(), 0, `${label}: and nothing is shown as loading`);
  assert.equal(await base.inputValue(), "", `${label}: no base is guessed`);
  await shoot("rest");
  // Compare stays disabled while the field, focused, is empty
  await base.focus();
  await shoot("disabled");
  if (!phone) {
    // the keyboard's focus ring: Tab from the field lands on the picker's toggle (and closes the list the click opened)
    await base.click();
    await page.keyboard.press("Tab");
    await page.locator(".repo-changes-base-toggle:focus-visible").waitFor();
    await shoot("focus-visible");
    await choose.hover();
    await shoot("hover");
  }

  // the picker: local and remote branches by their short names, the remote's symbolic HEAD left out
  const refsHeld = holdNext("refs");
  await choose.click();
  await refsHeld.reached;
  await page.locator(".repo-changes-refs[aria-busy='true']").waitFor();
  await shoot("loading-refs");
  refsHeld.release();
  const names = await refRows(page);
  assert.deepEqual(names, ["feat/idempotent-payments", LONG_BRANCH, "main", "release/2026.10", "origin/feat/idempotent-payments", "origin/main"], `${label}: the branches offered: ${JSON.stringify(names)}`);
  assert.equal(await page.locator(".repo-changes-refs [role='option'][aria-selected='true'] .menu-item-main").textContent(), "feat/idempotent-payments", `${label}: the first row is active`);
  assert.equal(await base.getAttribute("aria-expanded"), "true", `${label}: the field says its list is open`);
  await shoot("picker");
  if (!phone) {
    await page.locator(".repo-changes-refs [role='option']").nth(2).hover();
    await page.locator(".repo-changes-refs [role='option'][aria-selected='true'] .menu-item-main").filter({ hasText: /^main$/ }).waitFor();
    await shoot("picker-hover");
  }
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, menu: document.querySelector(".repo-changes-refs")!.getBoundingClientRect().right }));
  assert.ok(widths.page <= widths.viewport && widths.menu <= widths.viewport, `${label}: the picker stays on the screen: ${JSON.stringify(widths)}`);
  // the list is in the form's flow under the field and Compare: it covers neither, nor the scopes above them
  const placed = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return { list: box(".repo-changes-refs").top, compare: box(".repo-changes-base-form button[type=submit]").bottom, field: box(".repo-changes-base-input").bottom, position: getComputedStyle(document.querySelector(".repo-changes-refs")!).position };
  });
  assert.ok(placed.position === "static" && placed.list >= placed.compare && placed.list >= placed.field, `${label}: the list sits under the field and Compare: ${JSON.stringify(placed)}`);
  // typed text filters the rows; the arrow keys walk them; Enter takes one, by its full refname
  await base.fill("zzz");
  assert.equal(await refNote(page), t("No branch matches; Compare takes the name as typed."), `${label}: no match says so`);
  await shoot("picker-no-match");
  await base.fill("a-very-long");
  assert.deepEqual(await refRows(page), [LONG_BRANCH], `${label}: a long branch name is offered`);
  await shoot("long-refs");
  await base.fill("mai");
  assert.deepEqual(await refRows(page), ["main", "origin/main"], `${label}: the rows filtered by the typed text`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.locator(".repo-changes-refs").waitFor({ state: "detached" });
  assert.equal(await base.inputValue(), "origin/main", `${label}: Enter takes the active row`);
  assert.equal(await compare.isDisabled(), false, `${label}: Compare is ready with a base`);
  await shoot("selected");
  // Compare held down, then the list on its way
  const listHeld = holdNext("files");
  const box = (await compare.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await shoot("pressed");
  await page.mouse.up();
  await listHeld.reached;
  await page.locator(".repo-changes-loading").waitFor();
  await shoot("loading-list");
  listHeld.release();
  const rows = await changeRows(page, "branch");
  assert.deepEqual(rows, expectedRows, `${label}: the branch's changes, and none of the base's: ${JSON.stringify(rows)}`);
  const identity = await identityLine(page);
  // the identity line as the dictionary words it, its placeholders a short hash and the base's name
  const escaped = t("Compared from {hash}, the merge base with {base}").replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
  const identityPattern = new RegExp(`^${escaped.replace("\\{hash\\}", "[0-9a-f]{7}").replace("\\{base\\}", "origin/main")}$`);
  assert.match(identity, identityPattern, `${label}: the identity line: ${identity}`);
  const mergeBase = await page.locator(".repo-changes-list[data-scope='branch']").getAttribute("data-merge-base");
  assert.match(mergeBase ?? "", /^[0-9a-f]{40}$/, `${label}: the list carries its merge base`);
  await shoot("compared");
  // the list's own scroller at its end and the list's bottom edge on the screen: the last row whole and in view
  const listEnd = await page.evaluate(() => {
    const last = [...document.querySelectorAll<HTMLElement>(".repo-changes-list .repo-change")].at(-1)!;
    let scroller = last.parentElement;
    while (scroller !== null && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    // the list scrolls in itself (to its end), and on a phone the sheet around it too (to the list's bottom edge)
    if (scroller !== null) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.scrollIntoView({ block: "end", behavior: "instant" });
    }
    const row = last.getBoundingClientRect();
    const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
    const screen = visualViewport?.height ?? innerHeight;
    return { path: last.querySelector(".repo-change-path")?.textContent ?? "", atEnd: scroller === null || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1, visible: row.top >= view.top - 1 && row.bottom <= Math.min(view.bottom, screen) + 1, row: [row.top, row.bottom], view: [view.top, view.bottom], screen, inner: innerHeight, scroller: scroller?.className ?? null };
  });
  assert.ok(listEnd.path.endsWith("untracked.ts") && listEnd.atEnd && listEnd.visible, `${label}: the file list scrolled to its last row: ${JSON.stringify(listEnd)}`);
  await shoot("compared-end");

  // the untracked file's patch is whole, read from the pinned identity
  branchPatches.length = 0;
  const patchHeld = holdNext("file");
  await openChange(page, "src/untracked.ts");
  await patchHeld.reached;
  await shoot("loading-patch");
  patchHeld.release();
  await waitRows(page);
  assert.deepEqual(await rowTexts(page), { deletions: [], additions: ["export const fresh = 1;", "", "export const minted = 2;"] }, `${label}: the untracked file is all additions`);
  const meta = await page.locator(".repo-diff-meta").first().textContent();
  assert.ok(meta?.includes(t("Untracked")) && meta.includes(t("Since {base}").replace("{base}", "origin/main")), `${label}: the header names the base: ${meta}`);
  assert.equal(JSON.parse(branchPatches[0]!.get("comparison") ?? "{}").merge_base_oid, mergeBase, `${label}: the patch carried the list's identity`);
  assert.equal(branchPatches[0]!.get("base"), null, `${label}: and not the base's name`);
  await shoot("patch");
  await scrollDiff(page, "end");
  await shoot("patch-end");
  await page.getByRole("button", { name: words.closeDiff, exact: true }).click();
  await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
  await openChange(page, LONG_PATH.slice(LONG_PATH.lastIndexOf("/") + 1));
  await waitRows(page);
  await shoot("long-paths");
  await page.getByRole("button", { name: words.closeDiff, exact: true }).click();
  await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });

  // the base moves on alone: the open comparison stays, read from its pinned merge base
  const baseBefore = moveRef(repos.fork, "refs/remotes/origin/main", "base moves again");
  branchPatches.length = 0;
  await openChange(page, "src/shared.ts");
  await waitRows(page);
  const shared = await rowTexts(page);
  assert.deepEqual(shared, { deletions: ["export const six = 6;"], additions: ["export const six = 'branch edit';"] }, `${label}: the branch's edit alone, none of the base's: ${JSON.stringify(shared)}`);
  assert.equal(JSON.parse(branchPatches[0]!.get("comparison") ?? "{}").base_oid, baseBefore, `${label}: the patch is read from the base as it was listed`);
  await page.getByRole("button", { name: words.closeDiff, exact: true }).click();
  await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });

  // HEAD moves on: a patch says the list is to be refreshed, and Refresh lists again
  const headBefore = moveRef(repos.fork, "refs/heads/feat/idempotent-payments", "more branch work");
  await openChange(page, "src/shared.ts");
  assert.equal(await note(page), refreshRequired, `${label}: a moved HEAD asks for a refresh`);
  await shoot("refresh-required");
  await page.getByRole("button", { name: words.closeDiff, exact: true }).click();
  await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
  git(repos.fork, "update-ref", "refs/heads/feat/idempotent-payments", headBefore);
  await page.getByRole("button", { name: words.refresh, exact: true }).click();
  assert.deepEqual(await changeRows(page, "branch"), expectedRows, `${label}: Refresh lists the branch again`);

  // the same from a detached HEAD
  git(repos.fork, "checkout", "-q", "--detach");
  try {
    await closeFiles(page, words);
    await openFiles(page, "pane-fork", "local", words);
    await changeRows(page);
    await page.getByRole("button", { name: words.branch, exact: true }).click();
    await base.fill("main");
    await compare.click();
    assert.deepEqual(await changeRows(page, "branch"), expectedRows, `${label}: a detached HEAD compares as a branch does`);
    assert.equal(await page.locator(".repo-changes-branch").first().textContent(), t("Detached HEAD"), `${label}: and says it is detached`);
    await openChange(page, "src/routes.ts");
    await waitRows(page);
    await shoot("detached-patch");
    await page.getByRole("button", { name: words.closeDiff, exact: true }).click();
    await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
  } finally {
    git(repos.fork, "checkout", "-q", "feat/idempotent-payments");
  }

  // refusals, each in the app's words: an unknown base, a malformed one, unrelated histories, no commit yet
  await base.fill("nope");
  await compare.click();
  await page.locator(".repo-changes-error").filter({ hasText: t("No commit by that name.") }).waitFor();
  await shoot("invalid-base");
  await base.fill("main; ls");
  await compare.click();
  await page.locator(".repo-changes-error").filter({ hasText: t("Name a commit, branch or tag.") }).waitFor();
  await closeFiles(page, words);
  await openFiles(page, "pane-orphan", "local", words);
  await page.getByRole("button", { name: words.branch, exact: true }).click();
  await base.fill("main");
  await compare.click();
  await page.locator(".repo-changes-error").filter({ hasText: t("That base shares no history with HEAD.") }).waitFor();
  await shoot("invalid-ancestry");
  await closeFiles(page, words);
  await openFiles(page, "pane-unborn", "local", words);
  await page.getByRole("button", { name: words.branch, exact: true }).click();
  await choose.click();
  assert.equal(await refNote(page), t("This repository has no branches yet; a commit can still be typed."), `${label}: no branches says so`);
  await shoot("empty-refs");
  await base.fill("HEAD");
  await compare.click();
  await page.locator(".repo-changes-error").filter({ hasText: t("The repository has no commits yet, so there is no branch to compare.") }).waitFor();
  await shoot("unborn");
  await closeFiles(page, words);

  // more branches than are listed: the note says so, and one not listed is still a base when typed
  await openFiles(page, "pane-crowded", "local", words);
  await page.getByRole("button", { name: words.branch, exact: true }).click();
  await choose.click();
  const crowded = await refRows(page);
  assert.equal(crowded.length, 200, `${label}: the list stops at 200`);
  assert.ok(!crowded.includes("many/209"), `${label}: the last branches are not listed`);
  assert.equal(await refNote(page), t("Only the first {count} branches are listed; another can be typed by name.").replace("{count}", "200"), `${label}: a cut list says so`);
  await shoot("truncated-refs");
  await page.evaluate(() => { const menu = document.querySelector<HTMLElement>(".repo-changes-refs")!; menu.scrollTop = menu.scrollHeight; });
  await shoot("truncated-refs-end");
  await base.fill("many/209");
  await compare.click();
  await page.locator(".repo-changes-list[data-scope='branch'] .repo-changes-note").filter({ hasText: t("Nothing changed since the base") }).waitFor();
  await shoot("no-changes");
  await closeFiles(page, words);

  // a device that may only watch, and a PC whose bridge is from before the branch scope
  const observeStart = requests.length;
  await openFiles(page, "pane-observe", "local", words);
  await page.locator(".repo-changes-error").filter({ hasText: t("This device can only watch.") }).waitFor();
  assert.equal(await page.getByRole("button", { name: words.branch, exact: true }).count(), 0, `${label}: refused discovery offers no branch comparison`);
  assert.deepEqual(requests.slice(observeStart), ["/api/workspace/diff/repositories"], `${label}: a watching device is refused before files or refs are read`);
  await shoot("observe");
  await closeFiles(page, words);
  await openFiles(page, "pane-old", "local", words);
  await page.getByRole("button", { name: words.branch, exact: true }).click();
  await choose.click();
  assert.equal(await refNote(page), t("This PC's bridge cannot show changes yet."), `${label}: an older bridge's missing refs route is explained`);
  await base.fill("main");
  await compare.click();
  await page.locator(".repo-changes-error").filter({ hasText: t("This PC's bridge cannot compare branches yet.") }).waitFor();
  await shoot("older-pc");
  await closeFiles(page, words);
  const offlineStart = requests.length;
  await openFiles(page, "pane-offline", "local", words);
  await page.locator(".repo-changes-error").filter({ hasText: t("That PC is not reachable right now.") }).waitFor();
  assert.equal(await page.getByRole("button", { name: words.branch, exact: true }).count(), 0, `${label}: an offline PC offers no branch comparison`);
  assert.deepEqual(requests.slice(offlineStart), ["/api/workspace/diff/repositories"], `${label}: an offline PC stops at discovery`);
  await shoot("offline");
  await closeFiles(page, words);
  // nothing of this fetched or checked anything out: the branch is where it was, the base one commit on
  assert.equal(git(repos.fork, "rev-parse", "HEAD").trim(), headBefore, `${label}: HEAD is where it was`);
  assert.equal(git(repos.fork, "status", "--porcelain").split("\n").filter(Boolean).length, 6, `${label}: the working tree is as it was`);
  console.log(`PASS ${label}: the branch against a chosen base: picker, merge-base list with untracked files, pinned patches, refresh on a moved HEAD, detached HEAD, and every refusal`);
}
/** The text the rows `from`..`to` (indexes into the unified rows) hold, selected natively. */
async function selectRows(page: Page, from: number, to: number): Promise<string> {
  return page.evaluate(([from, to, rowsSource]) => {
    const rows = (new Function(`return (${rowsSource})()`) as () => HTMLElement[])();
    const range = document.createRange();
    range.setStart(rows[from]!, 0);
    range.setEnd(rows[to]!, rows[to]!.childNodes.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  }, [from, to, diffRows.toString()] as const);
}
async function copied(page: Page): Promise<string> {
  await page.keyboard.press("ControlOrMeta+c");
  return page.evaluate(() => navigator.clipboard.readText());
}
/** Find in the diff: the bar's count and place, its hint, its input, the marked row and the painted text. */
interface Found { count: string; place: string; hint: string; enabled: boolean; marked: { line: number; type: string | null; column: "old" | "new" | "unified"; inView: boolean }[]; painted: string[]; rows: number }
async function found(page: Page): Promise<Found> {
  return page.evaluate(() => {
    const bar = document.querySelector(".repo-diff-find");
    const status = bar?.querySelector(".find-bar-count");
    const shadow = document.querySelector(".repo-diff diffs-container")?.shadowRoot ?? null;
    const view = document.querySelector(".repo-diff-scroll")?.getBoundingClientRect();
    const marked = [...(shadow?.querySelectorAll<HTMLElement>("[data-line][data-find-active]") ?? [])].map((row) => {
      const rect = row.getBoundingClientRect();
      const code = row.closest("code");
      return { line: Number(row.dataset["line"]), type: row.dataset["lineType"] ?? null, column: code?.hasAttribute("data-deletions") ? "old" as const : code?.hasAttribute("data-additions") ? "new" as const : "unified" as const, inView: view !== undefined && rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1 };
    });
    const highlight = CSS.highlights.get("repo-diff-find");
    return {
      count: [...(status?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""),
      place: bar?.querySelector(".repo-diff-find-place")?.textContent ?? "",
      hint: bar?.querySelector(".find-bar-hint")?.textContent ?? "",
      enabled: bar?.querySelector<HTMLInputElement>("input")?.disabled === false,
      marked,
      painted: highlight ? [...highlight].map((range) => (range as Range).toString()) : [],
      rows: shadow?.querySelectorAll("[data-line]").length ?? 0,
    };
  });
}
/** Waits until the find bar says `count` and `place` and the active row is marked, in view, with its text painted. */
async function foundAt(page: Page, count: string, place: string, step: string): Promise<Found> {
  try {
    await page.waitForFunction(([count, place]) => {
      const bar = document.querySelector(".repo-diff-find");
      const status = [...(bar?.querySelector(".find-bar-count")?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("");
      if (status !== count || (bar?.querySelector(".repo-diff-find-place")?.textContent ?? "") !== place) return false;
      const row = document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector<HTMLElement>("[data-line][data-find-active]");
      const view = document.querySelector(".repo-diff-scroll")?.getBoundingClientRect();
      if (!row || !view) return false;
      const rect = row.getBoundingClientRect();
      return rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1 && (CSS.highlights.get("repo-diff-find")?.size ?? 0) === 1;
    }, [count, place] as const);
  } catch (error) {
    throw new Error(`${step}: the find never settled on ${count} / ${place}: ${JSON.stringify(await found(page))}`, { cause: error });
  }
  return found(page);
}
async function findShot(page: Page, width: number, theme: string, state: string): Promise<void> {
  if (evidence) await page.screenshot({ path: join(evidence, `diff-find-${width}-${theme}-${state}.png`) });
}

/** What the unified rows of a patch's first hunk say, in order, as the viewer draws them: deletions before additions within a change. */
function hunkRowTexts(patch: string, count: number): string[] {
  const body = patch.slice(patch.indexOf("\n@@"));
  const lines = body.split("\n").slice(1).filter((line) => !line.startsWith("@@") && !line.startsWith("\\"));
  return lines.slice(0, count).map((line) => line.slice(1));
}

try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/repo-diff-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const policy = (await serveStatic("/")).headers.get("content-security-policy");
  assert.ok(policy, "build the app before its enforcing CSP regression");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const answer = await api(request, url);
    if (answer) return answer;
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": policy } });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const moneyPatch = await (await repoDiffResponse("file", repos.main, new URLSearchParams({ scope: "workspace", path: "src/money.ts" }))).json() as { patch: string };
  assert.ok(moneyPatch.patch.includes("@@"), "the fixture's money.ts has a patch");
  // the headless shell, not the full browser of CHROME_PATH: its clipboard is in memory, so the real copy below is owned here
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  assert.match(browser.version(), /^\d+\./, "a browser launched");

  for (const [width, theme] of [[1440, "dark"], [1440, "light"], [390, "dark"], [390, "light"]] as const) {
    const label = `${width}px ${theme}`;
    const phone = width === 390;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, colorScheme: theme });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.addInitScript((theme) => {
      // once: a reload keeps what the page saved since (the diff layout)
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
      const record = window as unknown as { longTasks: number[] };
      record.longTasks = [];
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) record.longTasks.push(entry.duration); }).observe({ type: "longtask" });
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // the refusals asked for on purpose (a missing commit, a folder outside git, a malformed base, a watching
      // device, a bridge too old for the branch scope) are logged by the browser as failed loads
      if (/Failed to load resource/.test(message.text()) && /\/workspace\/diff\//.test(message.location().url ?? "") && /status of (?:400|403|404|409|503)/.test(message.text())) return;
      errors.push(`console: ${message.text()}`);
    });
    await page.goto(origin);

    await page.evaluate((directory) => window.repoDiffQA.openTurn("local", "pane-nested", directory), workspace);
    const turnList = page.locator(".turn-changed-files ul");
    await turnList.waitFor();
    const turnBounds = await turnList.evaluate((list) => {
      const row = list.querySelector("button")!.getBoundingClientRect();
      const status = document.querySelector<HTMLElement>('[role="status"]')!.getBoundingClientRect();
      return { rows: list.children.length, height: list.clientHeight, rowHeight: row.height, overflow: list.scrollHeight > list.clientHeight, horizontal: list.scrollWidth > list.clientWidth, statusVisible: status.bottom <= innerHeight };
    });
    assert.equal(turnBounds.rows, 12, `${label}: all edited files remain in the list`);
    assert.ok(turnBounds.height <= 5 * turnBounds.rowHeight + 10, `${label}: file list stays near five rows`);
    assert.ok(turnBounds.overflow && !turnBounds.horizontal && turnBounds.statusVisible, `${label}: internal scrolling keeps progress visible without horizontal overflow`);
    await turnList.focus();
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => document.querySelector(".turn-changed-files ul")!.scrollTop > 0);
    await turnList.locator("button").last().focus();
    assert.equal(await turnList.evaluate((list) => {
      const bounds = list.getBoundingClientRect(), last = list.lastElementChild!.getBoundingClientRect();
      return last.bottom <= bounds.bottom + 1 && last.top >= bounds.top;
    }), true, `${label}: keyboard focus reveals the final file`);
    await shot(page, `turn-list-${width}-${theme}`);
    await page.evaluate(() => window.repoDiffQA.closeFiles());
    console.log(`PASS ${label}: twelve turn files stay in a five-row scroll area with progress visible and keyboard access`);

    // the working tree's changes, each with its status, counts and the repository they are in
    await openFiles(page, "pane-main");
    const rows = await changeRows(page);
    assert.deepEqual(rows, [
      "M assets/pic.bin Binary",
      "M docs/new-name.md +1−1",
      "M notes/dir with space/ünï 文件.txt +1−1",
      "M src/big.ts +2,000−2,000",
      "D src/gone.ts +0−3",
      "M src/large.txt +8,000−8,000",
      "M src/money.ts +3−2",
      "? src/new.ts",
      "M src/staged.ts +1−1",
    ], `${label}: the working tree's changed files`);
    assert.equal(await page.locator(".repo-changes-branch").textContent(), "main", `${label}: the branch`);
    assert.equal(await page.locator(".repo-changes-root").textContent(), repos.main, `${label}: the repository root`);
    await shot(page, `list-${width}-${theme}`);

    // a 10 000-line diff: a window of rows at the top, the middle and the end, with old and new numbers
    const before = await page.evaluate(() => history.length);
    await openChange(page, "src/big.ts");
    // a phone's Files sheet holds an entry of its own, which the diff takes over (lib/sheetHistory.ts): one Back closes the diff
    assert.equal(await page.evaluate(() => history.length), phone ? before : before + 1, `${label}: the diff is a history entry`);
    await page.getByRole("dialog", { name: "Changes to big.ts", exact: true }).waitFor();
    await waitRows(page);
    const top = await mounted(page);
    assert.ok(top.rows > 0 && top.rows < 600, `${label}: bounded rows at the top: ${JSON.stringify(top)}`);
    assert.equal(top.first, 1, `${label}: the first row is line 1`);
    assert.equal(top.style, "single", `${label}: unified by default`);
    assert.ok(top.inView > 0, `${label}: rows in view at the top`);
    const numbers = await page.evaluate(() => {
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      const context = shadow.querySelector<HTMLElement>("[data-line][data-line-type='context'][data-alt-line]");
      const deletion = shadow.querySelector<HTMLElement>("[data-line][data-line-type='change-deletion']");
      const addition = shadow.querySelector<HTMLElement>("[data-line][data-line-type='change-addition']");
      const types: Record<string, number> = {};
      for (const row of shadow.querySelectorAll<HTMLElement>("[data-line]")) types[row.dataset["lineType"] ?? "?"] = (types[row.dataset["lineType"] ?? "?"] ?? 0) + 1;
      return { context: context && [context.dataset["line"], context.dataset["altLine"]], deletion: deletion?.dataset["line"] ?? deletion?.dataset["altLine"] ?? null, addition: addition?.dataset["line"] ?? addition?.dataset["altLine"] ?? null, types };
    });
    assert.deepEqual(numbers.context, ["1", "1"], `${label}: a context row carries its old and new numbers: ${JSON.stringify(numbers)}`);
    assert.ok(numbers.deletion === "4" && numbers.addition === "4", `${label}: the first change is line 4 on both sides: ${JSON.stringify(numbers)}`);
    const meta = await page.locator(".repo-diff-meta").first().textContent();
    assert.ok(meta?.includes("Modified") && meta.includes("+2,000") && meta.includes("−2,000") && meta.includes("Working tree"), `${label}: the header's status, counts and comparison: ${meta}`);
    await shot(page, `top-${width}-${theme}`);
    await scrollDiff(page, "middle");
    await rowReached(page, Math.floor(BIG_LINES / 2) - 1000, `${label} middle`);
    const middle = await mounted(page);
    assert.ok(middle.rows > 0 && middle.rows < 600 && middle.inView > 0 && middle.first > 1000, `${label}: bounded rows in the middle: ${JSON.stringify(middle)}`);
    // the last line is blank and past the last hunk's context: the diff's last row is the line before it
    await scrollDiff(page, "end");
    await rowReached(page, BIG_LINES - 1, `${label} end`);
    const end = await mounted(page);
    assert.ok(end.rows > 0 && end.rows < 600 && end.inView > 0, `${label}: bounded rows at the end: ${JSON.stringify(end)}`);
    assert.equal(end.last, BIG_LINES - 1, `${label}: the last row is the last hunk's last context line: ${JSON.stringify(end)}`);
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, dialog: document.querySelector(".repo-diff-viewer")!.getBoundingClientRect().width }));
    assert.ok(widths.page <= widths.viewport && widths.dialog <= widths.viewport, `${label}: nothing wider than the screen: ${JSON.stringify(widths)}`);
    await shot(page, `end-${width}-${theme}`);
    // the rows take the app's tokens, inside the shadow root
    const colors = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const resolve = (property: string, token: string) => { probe.style.setProperty(property, `var(${token})`); const value = getComputedStyle(probe).getPropertyValue(property); probe.style.removeProperty(property); return value; };
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      const row = shadow.querySelector<HTMLElement>("[data-line][data-line-type='context']")!;
      const result = { text: resolve("color", "--text"), row: getComputedStyle(row).color, bg: resolve("background-color", "--bg"), pre: getComputedStyle(shadow.querySelector("pre")!).backgroundColor, host: getComputedStyle(document.querySelector(".repo-diff diffs-container")!).backgroundColor };
      probe.remove();
      return result;
    });
    assert.equal(colors.row, colors.text, `${label}: the rows read in the app's text color: ${JSON.stringify(colors)}`);
    assert.ok([colors.bg, "rgba(0, 0, 0, 0)"].includes(colors.pre) && [colors.bg, "rgba(0, 0, 0, 0)"].includes(colors.host), `${label}: no code background of the package's own: ${JSON.stringify(colors)}`);
    // the package paints its gutter bars with the base colors verbatim and mixes the row tints from them
    const tints = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const resolve = (token: string) => { probe.style.backgroundColor = `var(${token})`; return getComputedStyle(probe).backgroundColor; };
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      const number = (type: string) => getComputedStyle(shadow.querySelector(`[data-column-number][data-line-type='${type}']`)!).color;
      const row = (type: string) => getComputedStyle(shadow.querySelector(`[data-line][data-line-type='${type}']`)!).backgroundColor;
      const result = { inserted: resolve("--syntax-inserted"), deleted: resolve("--syntax-deleted"), additionNumber: number("change-addition"), deletionNumber: number("change-deletion"), additionRow: row("change-addition"), deletionRow: row("change-deletion"), contextRow: row("context") };
      probe.remove();
      return result;
    });
    assert.equal(tints.additionNumber, tints.inserted, `${label}: an added row's number is the inserted token: ${JSON.stringify(tints)}`);
    assert.equal(tints.deletionNumber, tints.deleted, `${label}: a removed row's number is the deleted token: ${JSON.stringify(tints)}`);
    assert.ok(tints.additionRow !== tints.contextRow && tints.deletionRow !== tints.contextRow && tints.additionRow !== tints.deletionRow, `${label}: added and removed rows are each tinted: ${JSON.stringify(tints)}`);
    assert.ok((await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks)).every((task) => task < 1_000), `${label}: no long task of a second`);
    assert.deepEqual(errors, [], `${label}: no errors while opening the big diff`);
    console.log(`PASS ${label}: a 10 000-line diff as a bounded window of rows at the top, the middle and the end (rows ${top.rows}/${middle.rows}/${end.rows}), in the app's palette`);

    // unified or split: a setting kept across a reload; a phone draws one column and says why
    await scrollDiff(page, "top");
    const split = page.getByRole("button", { name: "Split", exact: true });
    if (phone) {
      assert.equal(await split.isDisabled(), true, `${label}: Split is declined on a phone`);
      await page.evaluate(() => window.repoDiffQA.settings({ diffStyle: "split" }));
      await page.locator(".repo-diff-notice").filter({ hasText: "Split view needs a wider screen; showing one column." }).waitFor();
      assert.equal((await mounted(page)).style, "single", `${label}: still one column with the setting on split`);
      await shot(page, `split-declined-${width}-${theme}`);
      await page.evaluate(() => window.repoDiffQA.settings({ diffStyle: "unified" }));
      await page.locator(".repo-diff-notice").filter({ hasText: "Split view needs a wider screen" }).waitFor({ state: "detached" });
      await closeDiff(page);
    } else {
      await split.click();
      await page.locator(".repo-diff[data-style='split']").waitFor();
      await page.waitForFunction(() => document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector("pre")?.getAttribute("data-diff-type") === "split");
      const splitRows = await mounted(page);
      assert.ok(splitRows.rows > 0 && splitRows.rows < 600 && splitRows.inView > 0, `${label}: bounded split rows: ${JSON.stringify(splitRows)}`);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).diffStyle), "split", `${label}: the layout is a saved setting`);
      await shot(page, `split-${width}-${theme}`);
      await page.reload();
      await page.getByRole("dialog", { name: "Changes to big.ts", exact: true }).waitFor();
      await waitRows(page);
      assert.equal((await mounted(page)).style, "split", `${label}: a reload keeps the diff open, split`);
      await page.getByRole("button", { name: "Unified", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector("pre")?.getAttribute("data-diff-type") === "single");
      // the reload lost the Files list beneath: Close steps back off the diff's entry, and the list is opened again
      await closeDiff(page);
      await openFiles(page, "pane-main");
      await changeRows(page);
    }
    console.log(`PASS ${label}: ${phone ? "a phone declines Split and says so" : "Split is kept across a reload, and Unified restored"}`);

    // the context folded to a line around each change, the numbers kept, and shown whole again
    await openChange(page, "src/money.ts");
    await waitRows(page);
    const whole = await page.evaluate(() => {
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      return { rows: shadow.querySelectorAll("[data-line]").length, separators: shadow.querySelectorAll("[data-separator='line-info']").length, secondChange: shadow.querySelectorAll<HTMLElement>("[data-line][data-line-type='change-addition']")[2]?.dataset["line"] };
    });
    await page.getByRole("button", { name: "Fold context", exact: true }).click();
    await page.locator(".repo-diff[data-folded]").waitFor();
    // the package re-renders its rows after the fold, not with it
    await page.waitForFunction((count) => { const rows = document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0; return rows > 0 && rows !== count; }, whole.rows);
    const folded = await page.evaluate(() => {
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      return { rows: shadow.querySelectorAll("[data-line]").length, separators: shadow.querySelectorAll("[data-separator='line-info']").length, secondChange: shadow.querySelectorAll<HTMLElement>("[data-line][data-line-type='change-addition']")[2]?.dataset["line"], folded: [...shadow.querySelectorAll("[data-unmodified-lines]")].map((node) => node.textContent) };
    });
    assert.ok(folded.rows < whole.rows, `${label}: fewer rows folded: ${JSON.stringify({ whole, folded })}`);
    assert.ok(folded.separators >= whole.separators, `${label}: the folded lines are counted in separators: ${JSON.stringify({ whole, folded })}`);
    assert.equal(folded.secondChange, whole.secondChange, `${label}: the second hunk keeps its line numbers: ${JSON.stringify({ whole, folded })}`);
    assert.ok(folded.folded.some((text) => /\d+ unmodified lines/.test(text ?? "")), `${label}: a separator says how many lines are folded: ${JSON.stringify(folded.folded)}`);
    await shot(page, `folded-${width}-${theme}`);
    await page.getByRole("button", { name: "Fold context", exact: true }).click();
    await page.locator(".repo-diff:not([data-folded])").waitFor();
    await page.waitForFunction((count) => (document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) === count, whole.rows);
    assert.equal(await page.evaluate(() => document.querySelector(".repo-diff diffs-container")!.shadowRoot!.querySelectorAll("[data-line]").length), whole.rows, `${label}: shown whole again`);
    console.log(`PASS ${label}: the context folds to a line around each change and unfolds, numbers kept`);

    // native selection and a real copy: the rows' text alone, blank lines kept, no gutter numbers
    if (!phone) {
      // the worker's colors redraw the rows, plain until then, and a redraw drops a selection made on the plain ones
      await page.locator(".repo-diff[data-colored]").waitFor();
      await page.waitForFunction(() => (document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line] span[style*='--herdr-code-token']").length ?? 0) > 0);
      const expected = hunkRowTexts(moneyPatch.patch, 7);
      assert.ok(expected.includes(""), "the selected rows span a blank line");
      const selected = await selectRows(page, 0, 6);
      assert.equal(selected, expected.join("\n"), `${label}: the selection is the rows' text with its blank line`);
      assert.equal(await copied(page), expected.join("\n"), `${label}: the real copy is the same text`);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      console.log(`PASS ${label}: native selection and a real copy keep blank lines and leave the gutters out`);
    }

    // the file itself opens on the owning PC, above the diff; Escape closes one surface at a time
    await page.getByRole("button", { name: "Open file", exact: true }).click();
    const file = page.getByRole("dialog", { name: "money.ts", exact: true });
    await file.waitFor();
    assert.ok(requests.some((path) => path === "/api/fs/stat"), `${label}: the file is read through the file routes`);
    await file.locator(".file-viewer-text .hl-line").first().waitFor();
    await page.keyboard.press("Escape");
    await file.waitFor({ state: "detached" });
    await page.locator(".repo-diff-viewer").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
    await page.getByRole("dialog", { name: "Files", exact: true }).waitFor();
    console.log(`PASS ${label}: Open file shows the file above the diff; Escape closes the file, then the diff, and the list stays`);

    // Back and Close return the focus to the row that opened the diff
    const row = page.locator(".repo-change").filter({ has: page.locator(".repo-change-path", { hasText: "src/money.ts" }) }).first();
    await row.focus();
    await page.keyboard.press("Enter");
    await page.locator(".repo-diff-viewer").waitFor();
    await page.evaluate(() => window.history.back());
    await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector(".repo-change-path")?.textContent), "src/money.ts", `${label}: Back returns the focus to the row`);
    await row.click();
    await page.locator(".repo-diff-viewer").waitFor();
    await closeDiff(page);
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector(".repo-change-path")?.textContent), "src/money.ts", `${label}: Close returns the focus to the row`);
    console.log(`PASS ${label}: Back and Close each close the diff alone and return the focus to its row`);

    // the kinds a diff cannot draw, and the kinds it draws from one side
    await openChange(page, "assets/pic.bin");
    assert.equal(await note(page), "This is a binary file; there are no lines to compare.", `${label}: a binary file says so`);
    assert.ok((await page.locator(".repo-diff-meta").first().textContent())?.includes("Binary"), `${label}: and is marked binary`);
    await shot(page, `binary-${width}-${theme}`);
    await closeDiff(page);
    await openChange(page, "src/large.txt");
    assert.equal(await note(page), "This change is larger than 1 MB and is not shown here.", `${label}: a change past the cap says so with the cap`);
    assert.equal(await page.getByRole("button", { name: "Copy patch", exact: true }).count(), 0, `${label}: nothing to copy of it`);
    await closeDiff(page);
    await openChange(page, "src/new.ts");
    await waitRows(page);
    const untracked = await page.evaluate(() => { const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!; return { additions: shadow.querySelectorAll("[data-line][data-line-type='change-addition']").length, deletions: shadow.querySelectorAll("[data-line][data-line-type='change-deletion']").length, context: shadow.querySelectorAll("[data-line][data-line-type='context']").length }; });
    assert.deepEqual(untracked, { additions: 3, deletions: 0, context: 0 }, `${label}: an untracked file is all additions: ${JSON.stringify(untracked)}`);
    assert.ok((await page.locator(".repo-diff-meta").first().textContent())?.includes("Untracked"), `${label}: and marked untracked`);
    await closeDiff(page);
    await openChange(page, "src/gone.ts");
    await waitRows(page);
    const deleted = await page.evaluate(() => { const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!; return { additions: shadow.querySelectorAll("[data-line][data-line-type='change-addition']").length, deletions: shadow.querySelectorAll("[data-line][data-line-type='change-deletion']").length }; });
    assert.deepEqual(deleted, { additions: 0, deletions: 3 }, `${label}: a deleted file is all deletions: ${JSON.stringify(deleted)}`);
    assert.equal(await page.getByRole("button", { name: "Open file", exact: true }).isDisabled(), true, `${label}: a deleted file cannot be opened`);
    await closeDiff(page);
    await openChange(page, "notes/dir with space/ünï 文件.txt");
    await waitRows(page);
    assert.equal(await page.getByRole("dialog", { name: "Changes to ünï 文件.txt", exact: true }).count(), 1, `${label}: a path with spaces and Unicode opens`);
    await closeDiff(page);
    console.log(`PASS ${label}: binary, too large, untracked, deleted and Unicode paths each show what they are`);

    // the index against HEAD: a rename with its old path; two commits by name; a commit that is not there
    await page.getByRole("button", { name: "Staged", exact: true }).click();
    const staged = await changeRows(page, "staged");
    assert.deepEqual(staged, ["R docs/old-name.md → docs/new-name.md +1−1", "M src/staged.ts +1−1"], `${label}: the staged changes: ${JSON.stringify(staged)}`);
    await openChange(page, "docs/new-name.md");
    await waitRows(page);
    const renamed = await page.locator(".repo-diff-meta").first().textContent();
    assert.ok(renamed?.includes("Renamed") && renamed.includes("Staged"), `${label}: a renamed file's header: ${renamed}`);
    assert.equal(await page.locator(".repo-diff-meta").first().getAttribute("title"), "Renamed from docs/old-name.md", `${label}: the old path is the tooltip`);
    await closeDiff(page);
    await page.getByRole("button", { name: "Commits", exact: true }).click();
    await page.getByLabel("From commit", { exact: true }).fill("HEAD~1");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const commits = await changeRows(page, "commit");
    assert.deepEqual(commits, ["A CHANGELOG.md +3−0", "M src/money.ts +1−1"], `${label}: the commits' changes: ${JSON.stringify(commits)}`);
    await openChange(page, "src/money.ts");
    await waitRows(page);
    assert.match((await page.locator(".repo-diff-compare").textContent()) ?? "", /^[0-9a-f]{7}\.\.[0-9a-f]{7}$/, `${label}: a commit comparison is named by its hashes`);
    await closeDiff(page);
    await page.getByLabel("From commit", { exact: true }).fill("nope");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.locator(".repo-changes-error").filter({ hasText: "No commit by that name." }).waitFor();
    await closeFiles(page);
    console.log(`PASS ${label}: staged renames, commit comparisons and a missing commit each read right`);

    // a conflicted file on a detached HEAD, and a folder that is no repository
    await openFiles(page, "pane-conflict");
    assert.deepEqual(await changeRows(page), ["U src/conflict.ts"], `${label}: a conflict is listed`);
    assert.equal(await page.locator(".repo-changes-branch").textContent(), "Detached HEAD", `${label}: a detached HEAD says so`);
    await openChange(page, "src/conflict.ts");
    assert.equal(await note(page), "This file has a merge conflict; resolve it in the terminal first.", `${label}: a conflict says so`);
    await closeDiff(page);
    await closeFiles(page);
    await openFiles(page, "pane-plain");
    await page.getByText("No Git repositories found in this folder.", { exact: true }).waitFor();
    await closeFiles(page);
    console.log(`PASS ${label}: a conflict, a detached HEAD and a folder outside git are each explained`);
    await page.evaluate((directory) => window.repoDiffQA.openFiles("local", "pane-nested", directory), workspace);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>(".turn-changed-files button")!.click());
    await waitRows(page);
    assert.match(await page.locator(".repo-diff-meta").textContent() ?? "", /Modified.*\+1.*−1/, `${label}: a turn file opens the nested repository's patch`);
    await shot(page, `nested-turn-${width}-${theme}`);
    await closeDiff(page);
    await closeFiles(page);
    assert.deepEqual(errors, [], `${label}: nested repository navigation has no errors`);
    console.log(`PASS ${label}: chat file opens the owning nested repository's diff`);
    for (const path of ["../external.log", `${workspace}/../external.log`]) {
      await page.evaluate((directory) => window.repoDiffQA.openFiles("local", "pane-nested", directory), workspace);
      await page.evaluate((path) => [...document.querySelectorAll<HTMLButtonElement>(".turn-changed-files button")].find((button) => button.textContent === path)?.click(), path);
      const viewer = page.getByRole("dialog", { name: "external.log", exact: true });
      await viewer.getByText("external file content", { exact: true }).waitFor();
      assert.match(await viewer.textContent() ?? "", /external file content/, `${label}: the external file's contents are readable`);
      await shot(page, `external-turn-${path.startsWith("/") ? "absolute" : "relative"}-${width}-${theme}`);
      await page.keyboard.press("Escape");
      await viewer.waitFor({ state: "detached" });
      await closeFiles(page);
    }
    assert.deepEqual(errors, [], `${label}: external file navigation has no errors`);
    console.log(`PASS ${label}: relative and absolute turn files outside the repository open in the file viewer`);
    await page.evaluate((directory) => window.repoDiffQA.openFiles("local", "pane-plain", directory), repos.plain);
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".turn-changed-files button")].find((button) => button.textContent === "../external.log")?.click());
    await page.getByRole("dialog", { name: "external.log", exact: true }).getByText("external file content", { exact: true }).waitFor();
    assert.match(await page.getByRole("dialog", { name: "external.log", exact: true }).textContent() ?? "", /external file content/, `${label}: a turn file also opens when the pane has no repository`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "external.log", exact: true }).waitFor({ state: "detached" });
    await closeFiles(page);
    assert.deepEqual(errors, [], `${label}: a non-repository pane opens its file without errors`);
    // Selecting an independent child must also change the root used by the opened diff.
    await openFiles(page, "pane-nested");
    const repositoryPicker = page.getByRole("combobox", { name: "Repository", exact: true });
    await page.waitForFunction(() => document.querySelectorAll('.repo-changes-picker option').length === 2);
    assert.deepEqual(await repositoryPicker.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)), [workspace, backend].sort());
    await repositoryPicker.selectOption(backend);
    assert.deepEqual(await changeRows(page), ["M server/test_out_work.py +1−1"], `${label}: child repository's changed file`);
    await openChange(page, "server/test_out_work.py");
    await waitRows(page);
    assert.match(await page.locator(".repo-diff-meta").textContent() ?? "", /Modified.*\+1.*−1/, `${label}: selected child owns the opened patch`);
    await closeDiff(page);
    await page.evaluate(() => window.repoDiffQA.settings({ changesChildRepos: false }));
    await page.waitForFunction(() => document.querySelectorAll('.repo-changes-picker option').length === 1);
    assert.equal(await repositoryPicker.inputValue(), workspace, `${label}: disabling child discovery selects the containing repository`);
    await page.evaluate(() => window.repoDiffQA.settings({ changesChildRepos: true, changesRepoDepth: 4 }));
    await page.waitForFunction(() => document.querySelectorAll('.repo-changes-picker option').length === 2);
    const bounds = await repositoryPicker.boundingBox();
    assert.ok(bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= width, `${label}: repository picker fits the viewport`);
    await shot(page, `repository-picker-${width}-${theme}`);
    await closeFiles(page);
    console.log(`PASS ${label}: child discovery toggle, repository selection and child diff ownership`);

    await openFiles(page, "pane-discovery");
    for (const depth of [1, 2, 3, 4]) {
      await page.evaluate((changesRepoDepth) => window.repoDiffQA.settings({ changesRepoDepth }), depth);
      await page.waitForFunction((count) => document.querySelectorAll('.repo-changes-picker option').length === count, depth);
      assert.deepEqual(await page.locator('.repo-changes-picker option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)), deepRoots.slice(0, depth).sort(), `${label}: folder depth ${depth}`);
    }
    await closeFiles(page);
    console.log(`PASS ${label}: all four discovery depths apply to independent repositories`);


    // Find in the 10 000-line diff: the whole loaded patch, its folded context and its rows not mounted
    await openFiles(page, "pane-main");
    await changeRows(page);
    await openChange(page, "src/big.ts");
    await waitRows(page);
    await page.getByRole("button", { name: "Fold context", exact: true }).click();
    await page.locator(".repo-diff[data-folded]").waitFor();
    const findButton = page.getByRole("button", { name: "Find in diff", exact: true });
    // a phone taps the header's Find; a keyboard presses Ctrl/Cmd+F with the focus on Fold context, which gets it back
    if (phone) await findButton.tap();
    else await page.keyboard.press("ControlOrMeta+f");
    const query = page.getByRole("searchbox", { name: "Find in diff", exact: true });
    await query.waitFor();
    assert.equal(await query.evaluate((input) => input === document.activeElement), true, `${label}: the query takes the focus`);
    if (!phone) {
      // a second Ctrl/Cmd+F on the open bar keeps the focus in the query, and Fold context keeps the return (checked at Escape)
      await page.keyboard.press("ControlOrMeta+f");
      assert.equal(await query.evaluate((input) => input === document.activeElement), true, `${label}: Ctrl/Cmd+F again keeps the query focused`);
    }
    assert.equal(await page.getByRole("dialog", { name: "Files", exact: true }).count(), 1, `${label}: the Files list stays beneath`);
    const hint = (await found(page)).hint;
    assert.equal(hint, "Searches this loaded patch, including context. Content outside the patch is not searched.", `${label}: the bar says what it searches`);
    // top, middle and end, each a context line the folded rows leave out
    for (const [text, line, where] of [["line_00002 ", 2, "top"], ["line_05002 ", 5002, "middle"], ["line_09998 ", 9998, "end"]] as const) {
      if (where !== "top") {
        await page.getByRole("button", { name: "Fold context", exact: true }).click();
        await page.locator(".repo-diff[data-folded]").waitFor();
      }
      await query.fill(text);
      const at = await foundAt(page, "1 of 1", `Unchanged line ${line.toLocaleString("en")}`, `${label} ${where}`);
      assert.equal(await page.locator(".repo-diff[data-folded]").count(), 0, `${label} ${where}: a folded-away hit shows the context whole`);
      assert.deepEqual(at.marked.map((row) => [row.line, row.type, row.inView]), [[line, "context", true]], `${label} ${where}: the hit's row is marked and in view: ${JSON.stringify(at)}`);
      assert.deepEqual(at.painted, [text], `${label} ${where}: the hit's text is painted`);
      assert.ok(at.rows > 0 && at.rows < 600, `${label} ${where}: the rows stay a bounded window: ${at.rows}`);
      if (where === "top") await findShot(page, width, theme, "folded");
      if (where === "end") await findShot(page, width, theme, "end");
    }
    // next and previous across both sides, wrapping
    await query.fill("line 9996");
    let at = await foundAt(page, "1 of 2", "Removed line 9,996", `${label} first`);
    assert.deepEqual(at.marked.map((row) => [row.line, row.type]), [[9996, "change-deletion"]], `${label}: the first hit is the removed line: ${JSON.stringify(at)}`);
    await query.press("Enter");
    at = await foundAt(page, "2 of 2", "Added line 9,996", `${label} next`);
    assert.deepEqual(at.marked.map((row) => [row.line, row.type]), [[9996, "change-addition"]], `${label}: Enter moves to the added line: ${JSON.stringify(at)}`);
    await query.press("Enter");
    await foundAt(page, "1 of 2", "Removed line 9,996", `${label} wrap`);
    await query.press("Shift+Enter");
    await foundAt(page, "2 of 2", "Added line 9,996", `${label} previous`);
    if (!phone) {
      // the same logical match through split, wrap and back
      await page.getByRole("button", { name: "Split", exact: true }).click();
      at = await foundAt(page, "2 of 2", "Added line 9,996", `${label} split`);
      assert.deepEqual(at.marked.map((row) => [row.line, row.column]), [[9996, "new"]], `${label}: split marks the new side's row: ${JSON.stringify(at)}`);
      await findShot(page, width, theme, "split-added");
      await page.getByRole("button", { name: "Previous match", exact: true }).click();
      at = await foundAt(page, "1 of 2", "Removed line 9,996", `${label} split previous`);
      assert.deepEqual(at.marked.map((row) => [row.line, row.column]), [[9996, "old"]], `${label}: split marks the old side's row: ${JSON.stringify(at)}`);
      await findShot(page, width, theme, "split-deleted");
      await page.evaluate(() => window.repoDiffQA.settings({ wrapCode: true }));
      at = await foundAt(page, "1 of 2", "Removed line 9,996", `${label} wrap on`);
      await page.getByRole("button", { name: "Unified", exact: true }).click();
      at = await foundAt(page, "1 of 2", "Removed line 9,996", `${label} unified`);
      assert.deepEqual(at.marked.map((row) => [row.line, row.type]), [[9996, "change-deletion"]], `${label}: unified keeps the match: ${JSON.stringify(at)}`);
      await page.evaluate(() => window.repoDiffQA.settings({ wrapCode: false }));
      await foundAt(page, "1 of 2", "Removed line 9,996", `${label} wrap off`);
    }
    // literal punctuation, an absent term
    await query.fill("= 9996; // changed");
    await foundAt(page, "1 of 1", "Added line 9,996", `${label} punctuation`);
    for (const absent of ["line_0999.", "line_.*", "LINE_09998"]) {
      await query.fill(absent);
      await page.locator(".repo-diff-find .find-bar-count").filter({ hasText: "No matches" }).waitFor();
      const none = await found(page);
      assert.deepEqual([none.marked, none.painted], [[], []], `${label}: "${absent}" finds nothing and marks nothing: ${JSON.stringify(none)}`);
    }
    await query.fill("line 9996");
    await query.press("Enter");
    await foundAt(page, "2 of 2", "Added line 9,996", `${label} before close`);
    // Escape closes Find, then the diff; the focus goes back to what opened Find
    await page.keyboard.press("Escape");
    await query.waitFor({ state: "detached" });
    await page.locator(".repo-diff-viewer").waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null), phone ? "Find in diff" : "Fold context", `${label}: the focus returns to the control that opened Find`);
    assert.equal((await found(page)).marked.length, 0, `${label}: no row stays marked`);
    // reopened untouched, Find shows the same query, count and active match again
    if (phone) await findButton.tap();
    else await findButton.click();
    await query.waitFor();
    assert.equal(await query.inputValue(), "line 9996", `${label}: the query is kept`);
    await foundAt(page, "2 of 2", "Added line 9,996", `${label} reopened`);
    await page.keyboard.press("Escape");
    await query.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null), "Find in diff", `${label}: the focus returns to Find, which reopened it`);
    await page.keyboard.press("Escape");
    await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
    await page.getByRole("dialog", { name: "Files", exact: true }).waitFor();
    console.log(`PASS ${label}: Find reaches folded context at the top, middle and end of 10 000 lines, steps across both sides${phone ? "" : " through split and wrap"}, takes punctuation literally, closes before the viewer${phone ? "" : " with a repeated Ctrl/Cmd+F"} and reopens on the same match`);

    // unwrapped rows: a match past the screen's right edge is scrolled into view across, and back for one at the start
    await page.evaluate(() => window.repoDiffQA.settings({ wrapCode: false }));
    await page.evaluate((directory) => window.repoDiffQA.openDiff({ machineId: "local", paneId: "pane-long", directory, scope: "workspace", base: null, head: null, comparison: null, path: "src/long.ts", oldPath: null }), repos.long);
    await waitRows(page);
    if (phone) await findButton.tap();
    else await page.keyboard.press("ControlOrMeta+f");
    await query.waitFor();
    const across = (): Promise<{ text: string; left: number; right: number; from: number; to: number; scrolled: number }> => page.evaluate(() => {
      const range = [...(CSS.highlights.get("repo-diff-find") ?? [])][0] as Range | undefined;
      const row = document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector<HTMLElement>("[data-line][data-find-active]");
      const scroller = row?.closest<HTMLElement>("[data-code]");
      if (!range || !scroller) return { text: "", left: 0, right: 0, from: 0, to: 0, scrolled: -1 };
      const rect = range.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      const gutter = scroller.querySelector("[data-gutter]")?.getBoundingClientRect().right ?? box.left;
      return { text: range.toString(), left: rect.left, right: rect.right, from: Math.max(box.left, gutter), to: box.left + scroller.clientWidth, scrolled: scroller.scrollLeft };
    });
    const inViewAcross = async (step: string): Promise<{ scrolled: number }> => {
      try {
        await page.waitForFunction(() => {
          const range = [...(CSS.highlights.get("repo-diff-find") ?? [])][0] as Range | undefined;
          const scroller = document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector<HTMLElement>("[data-line][data-find-active]")?.closest<HTMLElement>("[data-code]");
          if (!range || !scroller) return false;
          const rect = range.getBoundingClientRect();
          const box = scroller.getBoundingClientRect();
          const gutter = scroller.querySelector("[data-gutter]")?.getBoundingClientRect().right ?? box.left;
          return rect.left >= Math.max(box.left, gutter) && rect.right <= box.left + scroller.clientWidth;
        });
      } catch (error) {
        throw new Error(`${label} ${step}: the match never came into view across: ${JSON.stringify(await across())}`, { cause: error });
      }
      return across();
    };
    await query.fill("needle");
    await foundAt(page, "1 of 1", "Added line 2", `${label} long line`);
    const far = await inViewAcross("needle");
    assert.ok(far.scrolled > 0, `${label}: the rows scrolled across to the match: ${JSON.stringify(far)}`);
    await findShot(page, width, theme, "long-line");
    await query.fill("export const wide");
    await foundAt(page, "1 of 2", "Removed line 2", `${label} line start`);
    const near = await inViewAcross("line start");
    assert.ok(near.scrolled < far.scrolled, `${label}: the rows scrolled back for a match at the start: ${JSON.stringify(near)}`);
    if (!phone) {
      await page.getByRole("button", { name: "Split", exact: true }).click();
      await query.fill("needle");
      await foundAt(page, "1 of 1", "Added line 2", `${label} long line split`);
      await inViewAcross("needle in split");
      await page.getByRole("button", { name: "Unified", exact: true }).click();
    }
    // wrapped rows: a match at the end of a row taller than the view is brought into view itself, not the row's middle
    await page.evaluate(() => window.repoDiffQA.settings({ wrapCode: true }));
    await query.fill("haystack");
    const down = (): Promise<{ count: string; place: string; text: string; row: { top: number; bottom: number }; match: { top: number; bottom: number }; view: { top: number; bottom: number } }> => page.evaluate(() => {
      const bar = document.querySelector(".repo-diff-find");
      const range = [...(CSS.highlights.get("repo-diff-find") ?? [])][0] as Range | undefined;
      const row = document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector<HTMLElement>("[data-line][data-find-active]")?.getBoundingClientRect();
      const match = range?.getBoundingClientRect();
      const view = document.querySelector(".repo-diff-scroll")?.getBoundingClientRect();
      return {
        count: [...(bar?.querySelector(".find-bar-count")?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""),
        place: bar?.querySelector(".repo-diff-find-place")?.textContent ?? "",
        text: range?.toString() ?? "",
        row: { top: row?.top ?? 0, bottom: row?.bottom ?? 0 },
        match: { top: match?.top ?? 0, bottom: match?.bottom ?? 0 },
        view: { top: view?.top ?? 0, bottom: view?.bottom ?? 0 },
      };
    });
    try {
      await page.waitForFunction(() => {
        const range = [...(CSS.highlights.get("repo-diff-find") ?? [])][0] as Range | undefined;
        const view = document.querySelector(".repo-diff-scroll")?.getBoundingClientRect();
        if (!range || !view || range.toString() !== "haystack") return false;
        const match = range.getBoundingClientRect();
        return match.height > 0 && match.top >= view.top - 1 && match.bottom <= view.bottom + 1;
      });
    } catch (error) {
      throw new Error(`${label} tall wrapped row: the match never came into view: ${JSON.stringify(await down())}`, { cause: error });
    }
    const tall = await down();
    assert.deepEqual([tall.count, tall.place], ["1 of 1", "Unchanged line 3"], `${label}: the tall row's match is the active one: ${JSON.stringify(tall)}`);
    assert.ok(tall.row.bottom - tall.row.top > tall.view.bottom - tall.view.top, `${label}: the wrapped row is taller than the view: ${JSON.stringify(tall)}`);
    await findShot(page, width, theme, "tall-row");
    await page.evaluate(() => window.repoDiffQA.settings({ wrapCode: false }));
    await page.keyboard.press("Escape");
    await query.waitFor({ state: "detached" });
    await closeDiff(page);
    assert.deepEqual(errors, [], `${label}: no errors after the long line`);
    console.log(`PASS ${label}: a match past the right edge of an unwrapped row is scrolled into view across${phone ? "" : ", in split too"}, and back for one at the start; one at the end of a wrapped row taller than the view is brought into view itself`);

    // a comparison changed under live results drops them; a patch on its way, an offline PC and a watch-only device have none to search.
    // The Files list stays open beneath, as when a row opens a diff: closing a phone's sheet goes Back in history, which would race the next open
    const target = { machineId: "local", paneId: "pane-main", directory: repos.main, scope: "commit" as const, base: "HEAD~1", head: "HEAD", comparison: null, path: "src/money.ts", oldPath: null };
    await page.evaluate((target) => window.repoDiffQA.openDiff(target), target);
    await waitRows(page);
    await findButton.click();
    await query.fill("add");
    await foundAt(page, "1 of 1", "Added line 11", `${label} commit`);
    held = Promise.withResolvers<void>();
    await page.evaluate((target) => window.repoDiffQA.openDiff(target), { ...target, paneId: "pane-held" });
    await page.locator(".repo-diff-loading").waitFor();
    const loading = await found(page);
    assert.deepEqual([loading.count, loading.place, loading.enabled, loading.marked, loading.painted, loading.hint], ["", "", false, [], [], "There is no loaded patch to search."], `${label}: a patch on its way has nothing to search: ${JSON.stringify(loading)}`);
    await findShot(page, width, theme, "loading");
    held.resolve();
    await waitRows(page);
    const fresh = await found(page);
    assert.deepEqual([fresh.count, fresh.enabled, fresh.marked, await query.inputValue()], ["", true, [], ""], `${label}: the new patch starts with no stale anchor: ${JSON.stringify(fresh)}`);
    await query.fill("add");
    await foundAt(page, "1 of 1", "Added line 11", `${label} commit again`);
    await page.evaluate((target) => window.repoDiffQA.openDiff(target), { ...target, base: "nope" });
    assert.equal(await note(page), "No commit by that name.", `${label}: the refused comparison says why`);
    const refused = await found(page);
    assert.deepEqual([refused.count, refused.enabled, refused.marked, refused.painted, refused.hint], ["", false, [], [], "There is no loaded patch to search."], `${label}: a refused comparison drops the results: ${JSON.stringify(refused)}`);
    await findShot(page, width, theme, "error");
    await page.keyboard.press("Escape");
    await query.waitFor({ state: "detached" });
    assert.equal(await findButton.isDisabled(), true, `${label}: Find is off without a patch`);
    await page.keyboard.press("Escape");
    await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
    for (const [state, override, words] of [["offline", { machineId: "offline-pc" }, "That PC is not reachable right now."], ["watch", { paneId: "pane-watch" }, "This device can only watch."]] as const) {
      await page.evaluate((target) => window.repoDiffQA.openDiff(target), { ...target, scope: "workspace" as const, base: null, head: null, ...override });
      assert.equal(await note(page), words, `${label}: ${state} says why`);
      assert.equal(await findButton.isDisabled(), true, `${label}: Find is off when ${state}`);
      assert.equal(await findButton.getAttribute("title"), "There is no loaded patch to search.", `${label}: and says why when ${state}`);
      if (!phone) {
        await page.keyboard.press("ControlOrMeta+f");
        assert.equal(await query.count(), 0, `${label}: Ctrl/Cmd+F opens nothing when ${state}`);
      }
      await findShot(page, width, theme, state);
      await closeDiff(page);
    }
    for (const path of ["assets/pic.bin", "src/large.txt"]) {
      await page.evaluate((target) => window.repoDiffQA.openDiff(target), { ...target, scope: "workspace" as const, base: null, head: null, path });
      await note(page);
      assert.equal(await findButton.isDisabled(), true, `${label}: Find is off for ${path}`);
      await closeDiff(page);
    }
    await closeFiles(page);
    assert.deepEqual(errors, [], `${label}: no errors after Find`);
    console.log(`PASS ${label}: a changed comparison drops live results; loading, refused, offline, watch-only, binary and too-large patches leave Find off and say why`);

    // the branch against a chosen base: nothing is compared until a base is chosen and Compare pressed
    await branchReview(page, label, width, theme, EN);
    assert.deepEqual(errors, [], `${label}: no errors at the end`);
    await context.close();
  }

  // every new string once in Korean, on a phone
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "dark" });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "ko", theme: "dark" })));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await branchReview(page, "390px dark ko", 390, "dark", KO);
    assert.deepEqual(errors, [], "ko: no errors");
    await context.close();
  }

  // a PC whose branch list is still on its way when the reader switches PC: its late answer is dropped
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(origin);
    let release = (): void => {};
    branchHeld = { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
    await openFiles(page, "pane-fork", "slow-fixture");
    await page.getByRole("button", { name: EN.branch, exact: true }).click();
    await page.getByRole("button", { name: EN.choose, exact: true }).click();
    await page.locator(".repo-changes-refs[aria-busy='true'] .repo-changes-refs-note").filter({ hasText: "Loading" }).waitFor();
    await branchShot(page, "1440-dark-loading-refs-pc-switch");
    // the same pane on another PC: the picker closes, and its list is read from that PC
    await page.evaluate(([paneId, directory]) => window.repoDiffQA.openFiles("local", paneId, directory), ["pane-fork", repos.fork] as const);
    await page.locator(".repo-changes-refs").waitFor({ state: "detached" });
    await page.getByRole("button", { name: EN.choose, exact: true }).click();
    const local = await refRows(page);
    assert.ok(local.includes("origin/main") && local.length < 10, `the local PC's branches: ${JSON.stringify(local)}`);
    branchHeld.release();
    branchHeld = null;
    // the slow PC's crowded answer arrives now, and changes nothing
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("/api/machines/slow-fixture/workspace/diff/refs") && (entry as PerformanceResourceTiming).responseEnd > 0));
    assert.deepEqual(await refRows(page), local, "the late answer of the PC switched away from is not taken");
    await closeFiles(page);
    await context.close();
    console.log("PASS a branch list still on its way is dropped when the reader switches PC");
  }

  // another pane, folder or PC starts the Branch scope over: no base carried along, nothing compared
  // there until Compare; and a file list still on its way for the target left behind is dropped
  for (const width of [1440, 390] as const) {
    const phone = width === 390;
    const context: BrowserContext = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
    const page: Page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const base = page.getByRole("combobox", { name: EN.base, exact: true });
    const compare = page.getByRole("button", { name: EN.compare, exact: true });
    const awaiting = page.locator(".repo-changes-list .repo-changes-note").filter({ hasText: "Choose a base, then Compare." });
    const targets = [["pane-fork", "local"], ["pane-main", "local"], ["pane-main", "remote-fixture"]] as const;
    await openFiles(page, targets[0][0], targets[0][1]);
    await changeRows(page);
    await page.getByRole("button", { name: EN.branch, exact: true }).click();
    for (let index = 1; index < targets.length; index += 1) {
      await base.fill("main");
      await compare.click();
      await page.locator(".repo-changes-list[data-scope='branch']").waitFor();
      diffQueries.length = 0;
      const [paneId, machine] = targets[index]!;
      await openFiles(page, paneId, machine);
      await awaiting.waitFor();
      const state = { base: await base.inputValue(), compareDisabled: await compare.isDisabled(), branchPressed: await page.getByRole("button", { name: EN.branch, exact: true }).getAttribute("aria-pressed"), repositoryLines: await page.locator(".repo-changes-repo").count(), branchReads: diffQueries.filter((query) => query.includes("/diff/files") && query.includes("scope=branch")) };
      assert.deepEqual(state, { base: "", compareDisabled: true, branchPressed: "true", repositoryLines: 0, branchReads: [] }, `${width}px: ${paneId} on ${machine} starts the Branch scope over: ${JSON.stringify(state)}`);
      if (index === 1) await branchShot(page, `${width}-dark-target-change`);
    }
    // a working-tree list held for pane-fork; the reader picks Branch, then another pane; the held list lands late
    await page.getByRole("button", { name: "Working tree", exact: true }).click();
    await changeRows(page);
    const staleList = holdNext("files");
    await openFiles(page, "pane-fork", "local");
    await staleList.reached;
    await page.getByRole("button", { name: EN.branch, exact: true }).click();
    await openFiles(page, "pane-main", "local");
    await awaiting.waitFor();
    const landed = page.waitForResponse((response) => response.url().includes("/workspace/diff/files") && response.url().includes("pane_id=pane-fork"));
    staleList.release();
    await (await landed).finished();
    // the answer is in; React has had a frame to (wrongly) show it
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after: Record<string, number | boolean> = { rows: await page.locator(".repo-change").count(), repositoryLines: await page.locator(".repo-changes-repo").count(), awaiting: await awaiting.count(), compareDisabled: await compare.isDisabled() };
    assert.deepEqual(after, { rows: 0, repositoryLines: 0, awaiting: 1, compareDisabled: true }, `${width}px: the late list of the pane left behind is dropped: ${JSON.stringify(after)}`);
    await branchShot(page, `${width}-dark-stale-list-dropped`);
    // and one still on its way when the view closes lands on nothing
    const closing = holdNext("files");
    await page.getByRole("button", { name: "Working tree", exact: true }).click();
    await openFiles(page, "pane-fork", "local");
    await closing.reached;
    await closeFiles(page);
    closing.release();
    assert.deepEqual(errors, [], `${width}px: no errors across the target switches`);
    await context.close();
    console.log(`PASS ${width}px: another pane, folder or PC starts the Branch scope over, and a list read for the target left behind is dropped`);
  }

  // a remote PC's repository reads through its bridge, the file too
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(origin);
    requests.length = 0;
    await openFiles(page, "pane-main", "remote-fixture");
    await changeRows(page);
    await openChange(page, "src/money.ts");
    await waitRows(page);
    await page.getByRole("button", { name: "Open file", exact: true }).click();
    await page.getByRole("dialog", { name: "money.ts", exact: true }).waitFor();
    assert.deepEqual(requests.filter((path) => path.includes("/workspace/diff/")), ["repositories", "files", "file"].map((kind) => `/api/machines/remote-fixture/workspace/diff/${kind}`), `remote diff requests: ${requests.join(", ")}`);
    assert.ok(requests.some((path) => path === "/api/machines/remote-fixture/fs/stat"), `remote file requests: ${requests.join(", ")}`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "money.ts", exact: true }).waitFor({ state: "detached" });
    await closeDiff(page);
    await closeFiles(page);
    await page.evaluate((directory) => window.repoDiffQA.openFiles("remote-fixture", "pane-nested", directory), workspace);
    requests.length = 0;
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".turn-changed-files button")].find((button) => button.textContent === "../external.log")?.click());
    await page.getByRole("dialog", { name: "external.log", exact: true }).getByText("external file content", { exact: true }).waitFor();
    assert.ok(requests.some((path) => path === "/api/machines/remote-fixture/fs/file"), "the external file is read from the owning remote PC");
    await context.close();
    console.log("PASS a remote PC's changes and files read through its bridge");
  }

  // the static demo answers the routes from its fixture: the list, a diff and no missing route
  {
    const app = join(root, "demo");
    await buildDemoApp(app);
    const index = join(app, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
    demoServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      const prefix = "/herdr-web-ui/demo/app/";
      if (!path.startsWith(prefix) && !path.startsWith("/icons/")) return new Response("not found", { status: 404 });
      let file = decodeURIComponent(path.startsWith("/icons/") ? path.slice(1) : path.slice(prefix.length));
      if (!file || file.endsWith("/")) file += "index.html";
      const body = Bun.file(join(app, file));
      return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
    } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const missing: string[] = [];
    page.on("response", (response) => { if (response.status() === 404) missing.push(response.url()); });
    // the demo ends its opening agent turn on a 4.5 s timer (site/demo/transport.ts); run the clock past it
    // first, so the sheet's backdrop is the finished turn in every capture rather than whichever the timer reached
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${demoServer.port}/herdr-web-ui/demo/app/`);
    await page.clock.runFor(4_500);
    // a computer's header opens Files from its own button (the More menu keeps it on a phone)
    await page.locator(".header-files-button").click();
    await page.getByRole("dialog", { name: "Files", exact: true }).waitFor();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const demoRows = await changeRows(page);
    assert.deepEqual(demoRows, ["M docs/checkout-flow.png Binary", "R src/idempotency.ts → src/lib/idempotency.ts +0−0", "? src/money.test.ts", "M src/money.ts +4−1"], `the demo's changes: ${JSON.stringify(demoRows)}`);
    await openChange(page, "src/money.ts");
    await waitRows(page);
    const demoDiff = await mounted(page);
    assert.ok(demoDiff.rows >= 8 && demoDiff.rows < 40, `the demo's diff rows: ${JSON.stringify(demoDiff)}`);
    await shot(page, "demo-1440-dark");
    await closeDiff(page);
    await openChange(page, "src/lib/idempotency.ts");
    assert.equal(await note(page), "No lines changed.", "a pure rename has no lines");
    await closeDiff(page);
    // the demo's branch against its fictional main: the picker's refs, the branch's own commit and a pinned patch
    await page.getByRole("button", { name: EN.branch, exact: true }).click();
    await page.getByRole("button", { name: EN.choose, exact: true }).click();
    const demoRefs = await refRows(page);
    // only bases the demo can compare are offered: none of them answers "No commit by that name"
    assert.deepEqual(demoRefs, ["main", "origin/main"], `the demo's branches: ${JSON.stringify(demoRefs)}`);
    await page.locator(".repo-changes-refs [role='option']").filter({ has: page.locator(".menu-item-main", { hasText: /^main$/ }) }).click();
    await page.getByRole("button", { name: EN.compare, exact: true }).click();
    const demoBranch = await changeRows(page, "branch");
    assert.deepEqual(demoBranch, ["M docs/checkout-flow.png Binary", "R src/idempotency.ts \u2192 src/lib/idempotency.ts +0\u22120", "? src/money.test.ts", "M src/money.ts +4\u22121", "M src/routes/payments.ts +3\u22121"], `the demo's branch changes: ${JSON.stringify(demoBranch)}`);
    await openChange(page, "src/routes/payments.ts");
    await waitRows(page);
    assert.ok((await page.locator(".repo-diff-meta").first().textContent())?.includes("Since main"), "the demo's branch patch names its base");
    await shot(page, "demo-branch-1440-dark");
    await closeDiff(page);

    assert.deepEqual(missing, [], `no missing route in the demo: ${missing.join(", ")}`);
    await context.close();
    console.log("PASS the static demo lists its fixture's changes and draws a diff with no missing route");
  }
  for (const [width, theme] of [[1440, "dark"], [390, "light"]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
    await context.addInitScript((theme) => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const openDiscoverySettings = async (): Promise<void> => {
      await page.locator(".conn-live").waitFor();
      if (await page.locator(".settings-dialog").count() === 0) await page.keyboard.press("ControlOrMeta+Shift+Comma");
      await openSettingsPage(page, "Chat");
      await page.locator('[data-section="changes"]').scrollIntoViewIfNeeded();
    };
    await page.goto(`http://127.0.0.1:${demoServer!.port}/herdr-web-ui/demo/app/`);
    await openDiscoverySettings();
    const toggle = page.getByRole("switch", { name: "Look for repos inside this folder", exact: true });
    const depths = page.getByRole("group", { name: "How deep to look", exact: true });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await depths.getByRole("button", { name: "2", exact: true }).getAttribute("aria-pressed"), "true");
    await depths.getByRole("button", { name: "4", exact: true }).click();
    await toggle.click();
    assert.equal(await depths.count(), 0, "depth is hidden while child discovery is off");
    await page.reload();
    await openDiscoverySettings();
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "discovery toggle survives reload");
    await toggle.click();
    assert.equal(await depths.getByRole("button", { name: "4", exact: true }).getAttribute("aria-pressed"), "true", "depth survives reload");
    const overflow = await page.locator('[data-section="changes"]').evaluate((section) => [...section.querySelectorAll<HTMLElement>("button, .settings-row")].some((node) => {
      const box = node.getBoundingClientRect(), edge = section.getBoundingClientRect();
      return box.left < edge.left - 1 || box.right > edge.right + 1;
    }));
    assert.equal(overflow, false, "repository discovery controls fit the settings card");
    await shot(page, `discovery-settings-${width}-${theme}`);
    await context.close();
    console.log(`PASS ${width}px ${theme}: discovery controls, defaults, persistence and layout in Settings`);
  }
  console.log("repository diff: browser OK (discovery/depth, list, bounded rows, unified/split, fold, copy, open file, Back/Close/focus, unavailable kinds, staged/commits/errors, branch against a base, remote, demo)");
} finally {
  await browser?.close(); server?.stop(true); demoServer?.stop(true); rmSync(root, { recursive: true, force: true });
}
