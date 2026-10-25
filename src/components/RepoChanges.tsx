import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Folder, FolderOpen, GitBranch, GitMerge, RefreshCw } from "lucide-react";

import "./RepoChanges.css";
import { FileGlyph } from "./FileGlyph.tsx";
import { Skeleton } from "./Skeleton.tsx";

import type { RepoDiffFile, RepoDiffFileList, RepoDiffRepositories, RepoDiffRefs, RepoDiffScope } from "../../shared/protocol.ts";
import { changeTree, changeTreeFolders, type ChangeTreeEntry } from "../lib/changeTree.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { diffErrorMessage, nothingChangedWord, refName, shortHash, STATUS_MARK, statusWord, type RepoComparison } from "../lib/repoDiff.ts";
import { skeletonRows } from "../lib/skeleton.ts";
import { useSettings } from "../lib/settings.ts";
import { routeMissing } from "../lib/api.ts";

export interface RepoChangesProps {
  paneId: string;
  /** the pane's folder, read when the pane is gone */
  directory: string;
  onOpenDiff: (comparison: RepoComparison, file: RepoDiffFile, directory: string) => void;
}

/** Pick one repository before reading changes, so a workspace never fans out git processes. */
export function RepoChanges(props: RepoChangesProps) {
  const t = useT();
  const { settings } = useSettings();
  const [scope, setScope] = useState<RepoDiffScope>("workspace");
  const { fetchRepoDiffRepositories } = useMachineApi();
  const [found, setFound] = useState<RepoDiffRepositories | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setFound(null);
    setError(null);
    fetchRepoDiffRepositories({ paneId: props.paneId, directory: props.directory }, settings.changesChildRepos, settings.changesRepoDepth).then((answer) => {
      if (active) { setFound(answer); setSelected((current) => current !== null && answer.roots.includes(current) ? current : answer.roots[0] ?? null); }
    }, (reason: unknown) => {
      if (!active) return;
      // Older remote bridges still support their original, single-repository Changes view.
      if (routeMissing(reason)) { setFound({ roots: [props.directory], truncated: false }); setSelected(props.directory); }
      else setError(reason);
    });
    return () => { active = false; };
  }, [fetchRepoDiffRepositories, props.paneId, props.directory, settings.changesChildRepos, settings.changesRepoDepth, refresh]);
  return <>
    <div className="repo-changes-bar">
      <label className="field repo-changes-picker">
        <span className="field-label">{t("Repository")}</span>
        <select className="input" aria-label={t("Repository")} title={selected ?? undefined} disabled={found === null || found.roots.length === 0} value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>
          {found?.roots.map((root) => <option key={root} value={root}>{root.split(/[\\/]/).at(-1) || root} · {root}</option>)}
        </select>
      </label>
      <button type="button" className="icon-button" aria-label={t("Refresh repositories")} disabled={found === null && error === null} onClick={() => setRefresh((current) => current + 1)}><RefreshCw aria-hidden="true" /></button>
    </div>
    {error !== null && <p className="repo-changes-note repo-changes-error" role="alert">{diffErrorMessage(t, error)}</p>}
    {found === null && error === null && <p className="repo-changes-note" role="status">{t("Loading…")}</p>}
    {found?.truncated && <p className="repo-changes-note" role="status">{t("Repository search was incomplete. Try a smaller folder or depth.")}</p>}
    {found?.roots.length === 0 && <p className="repo-changes-note">{t("No Git repositories found in this folder.")}</p>}
    {found !== null && selected !== null && <RepositoryChanges key={`${props.paneId}:${selected}`} {...props} directory={selected} scope={scope} setScope={setScope} />}
  </>;
}

type Load = { status: "pending" } | { status: "failed"; error: unknown } | { status: "ready"; listing: RepoDiffFileList };
const PENDING: Load = { status: "pending" };

/** The branches offered as a base: read when the picker opens, never before. */
type Refs = { status: "idle" } | { status: "pending" } | { status: "failed"; error: unknown } | { status: "ready"; listing: RepoDiffRefs };
const NO_REFS: Refs = { status: "idle" };

/**
 * What changed in the repository the pane sits in: the working tree, the index, two commits, or
 * the branch against a base of the reader's choosing (the working tree against the merge base of
 * that base and HEAD, as Codex's review pane compares a branch), one file per row with its status
 * and counts, each opened as its diff, under the folders they sit in (lib/changeTree.ts): every
 * folder starts open, and what the reader folds stays folded across refreshes and comparisons.
 * The list is read on each choice and on Refresh, never polled; while it is read, the last list's
 * repository line stays and placeholder rows hold its height. A base is never guessed: the
 * Branch scope starts empty, offers the repository's branches when its picker opens, and compares
 * on Compare alone; the identity a branch list answers with (HEAD, base, merge base) is what each
 * of its files is read from, so a base that moves on changes nothing until Refresh. Another PC,
 * pane or folder starts the Branch scope over (no base, nothing compared until Compare), and an
 * answer read for a target or comparison no longer shown is dropped.
 */
function RepositoryChanges({ paneId, directory, onOpenDiff, scope, setScope }: RepoChangesProps & { scope: RepoDiffScope; setScope: (scope: RepoDiffScope) => void }) {
  const t = useT();
  const locale = useLocale();
  const { fetchRepoDiffFiles, fetchRepoDiffRefs } = useMachineApi();
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  // the comparison read last: a commit or branch comparison waits for Compare, the others read on choice
  const [asked, setAsked] = useState<RepoComparison | null>(scope === "branch" || scope === "commit" ? null : { scope, base: null, head: null, comparison: null });
  const [load, setLoad] = useState<Load>(PENDING);
  // the last listing, kept while the next is read: its repository line stays and its rows size the placeholders
  const [last, setLast] = useState<RepoDiffFileList | null>(null);
  const request = useRef(0);

  // the base picker: the typed text, the row picked from the list (while the text still reads as it), and the list itself
  const [baseRef, setBaseRef] = useState("");
  const [picked, setPicked] = useState<RepoDiffRefs["refs"][number] | null>(null);
  const [refs, setRefs] = useState<Refs>(NO_REFS);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [active, setActive] = useState(0);
  const refsRequest = useRef(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const refsRef = useRef<HTMLDivElement>(null);
  const baseInputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const baseLabelId = useId();

  // another PC, pane or folder: nothing read or chosen for the last one is an answer for this one.
  // Reset while rendering, so the read below never starts the last target's branch comparison here.
  const target = useMemo(() => ({ paneId, directory }), [fetchRepoDiffFiles, fetchRepoDiffRefs, paneId, directory]);
  const [shownTarget, setShownTarget] = useState(target);
  if (shownTarget !== target) {
    setShownTarget(target);
    setLast(null);
    setRefs(NO_REFS);
    setPickerOpen(false);
    setBaseRef("");
    setPicked(null);
    setLoad(PENDING);
    if (scope === "branch") setAsked(null);
  }
  // and what is still on its way for the last target (or for a closed view) is dropped when it lands
  useEffect(() => () => { request.current += 1; refsRequest.current += 1; }, [target]);

  const read = useCallback((comparison: RepoComparison) => {
    const id = ++request.current;
    setLoad(PENDING);
    fetchRepoDiffFiles({ paneId, directory, ...comparison }).then(
      (listing) => {
        if (id !== request.current) return;
        setLoad({ status: "ready", listing });
        setLast(listing);
      },
      (error: unknown) => { if (id === request.current) setLoad({ status: "failed", error }); },
    );
  }, [fetchRepoDiffFiles, paneId, directory]);

  useEffect(() => { if (asked !== null) read(asked); }, [asked, read]);

  const loadRefs = useCallback(() => {
    const id = ++refsRequest.current;
    setRefs({ status: "pending" });
    fetchRepoDiffRefs({ paneId, directory }).then(
      (listing) => { if (id === refsRequest.current) setRefs({ status: "ready", listing }); },
      (error: unknown) => { if (id === refsRequest.current) setRefs({ status: "failed", error }); },
    );
  }, [fetchRepoDiffRefs, paneId, directory]);

  const openPicker = (): void => {
    setActive(0);
    setPickerOpen(true);
    loadRefs();
  };

  useEffect(() => {
    if (!pickerOpen) return;
    // the list sits in the form, under the field and Compare, so it moves with them and covers neither;
    // a click anywhere else closes it once the click is done: closing on the press would move Compare
    // (and what is under it) away from the pointer before it is released
    const onClick = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!pickerRef.current?.contains(target) && !refsRef.current?.contains(target)) setPickerOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [pickerOpen]);

  const refsListing = refs.status === "ready" ? refs.listing : null;
  const typed = baseRef.trim();
  const query = typed.toLowerCase();
  const options = useMemo(() => refsListing === null ? [] : refsListing.refs.filter((ref) => query === "" || refName(ref.name).toLowerCase().includes(query)), [refsListing, query]);
  const activeOption = options[Math.min(active, options.length - 1)];

  useEffect(() => {
    if (!pickerOpen || activeOption === undefined) return;
    const option = document.getElementById(`${listId}-${activeOption.name}`);
    const menu = option?.parentElement;
    if (!option || !menu) return;
    const optionBounds = option.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    if (optionBounds.top < menuBounds.top) menu.scrollTop -= menuBounds.top - optionBounds.top;
    else if (optionBounds.bottom > menuBounds.bottom) menu.scrollTop += optionBounds.bottom - menuBounds.bottom;
  }, [pickerOpen, activeOption, listId]);

  const pick = (ref: RepoDiffRefs["refs"][number]): void => {
    setBaseRef(refName(ref.name));
    setPicked(ref);
    setPickerOpen(false);
    baseInputRef.current?.focus();
  };

  const onBaseKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!pickerOpen) { openPicker(); return; }
      const last = Math.max(0, options.length - 1);
      setActive((index) => (event.key === "ArrowDown" ? Math.min(last, index + 1) : Math.max(0, index - 1)));
    } else if (event.key === "Escape" && pickerOpen) {
      // cancel: close the list only, not the dialog around it
      event.preventDefault();
      event.stopPropagation();
      setPickerOpen(false);
    } else if (event.key === "Enter" && pickerOpen && activeOption !== undefined) {
      // a row on the list is taken; with none, Enter submits the typed name
      event.preventDefault();
      pick(activeOption);
    } else if (event.key === "Tab") {
      setPickerOpen(false);
    }
  };

  const choose = (next: RepoDiffScope): void => {
    setScope(next);
    setPickerOpen(false);
    // a list still on its way is no answer for a scope that waits for Compare
    if (next === "commit" || next === "branch") { request.current += 1; setAsked(null); setLoad(PENDING); return; }
    setAsked({ scope: next, base: null, head: null, comparison: null });
  };
  const compare = (event: FormEvent): void => {
    event.preventDefault();
    const from = base.trim();
    if (from === "") return;
    setAsked({ scope: "commit", base: from, head: head.trim() || null, comparison: null });
  };
  const compareBranch = (event: FormEvent): void => {
    event.preventDefault();
    if (typed === "") return;
    setPickerOpen(false);
    // a row picked from the list goes by its full refname, so `main` is the branch and never a tag of that name
    setAsked({ scope: "branch", base: picked !== null && refName(picked.name) === typed ? picked.name : typed, head: null, comparison: null });
  };

  const listing = load.status === "ready" ? load.listing : null;
  // the Branch scope before its first Compare: nothing is read, so nothing is shown as loading
  const awaitingBase = scope === "branch" && asked === null;
  // a file is read from the comparison the list answered for: a commit comparison's hashes, a branch comparison's identity
  const answered: RepoComparison | null = listing === null ? null
    : listing.scope === "branch" ? { scope: "branch", base: refName(asked?.base ?? ""), head: null, comparison: listing.comparison ?? null }
    : { scope: listing.scope, base: listing.base, head: listing.head, comparison: null };
  const repository = listing?.repository ?? last?.repository ?? null;
  const branch = repository === null ? null : repository.branch ?? (repository.unborn ? t("No commits yet") : t("Detached HEAD"));
  // the last list's folders keep the fold-all control steady while the next list is read
  const shown = listing ?? last;
  const tree = useMemo(() => changeTree(shown === null ? [] : shown.files.map((file) => file.path)), [shown]);
  const folders = useMemo(() => changeTreeFolders(tree), [tree]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const allOpen = folders.every((path) => !folded.has(path));
  const toggle = (path: string): void => setFolded((current) => {
    const next = new Set(current);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  const rows = (entries: readonly ChangeTreeEntry[], files: readonly RepoDiffFile[], comparison: RepoComparison): ReactNode[] => entries.map((entry) => {
    const indent = { "--depth": entry.depth } as CSSProperties;
    if (entry.kind === "folder") {
      const open = !folded.has(entry.path);
      return <li key={`folder:${entry.path}`}>
        <button type="button" className="repo-change-folder" style={indent} aria-expanded={open} onClick={() => toggle(entry.path)}>
          <span className="repo-change-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
          {open ? <FolderOpen className="repo-change-glyph" aria-hidden="true" /> : <Folder className="repo-change-glyph" aria-hidden="true" />}
          <span className="repo-change-folder-name">{entry.name}</span>
          <span className="repo-change-folder-count" aria-hidden="true">{entry.files.toLocaleString(locale)}</span>
        </button>
        {open && <ul className="repo-change-children">{rows(entry.entries, files, comparison)}</ul>}
      </li>;
    }
    const file = files[entry.index]!;
    const word = statusWord(t, file.status);
    // the folder is said, not shown: the row sits under it, and assistive tech (and the browser scripts) read the whole path
    const folder = file.path.slice(0, file.path.length - entry.name.length);
    // a rename within the folder names only the old file; one from elsewhere says where from
    const sameFolder = file.old_path !== null && file.old_path.slice(0, file.old_path.lastIndexOf("/") + 1) === folder;
    return <li key={file.path}>
      <button type="button" className="repo-change" style={indent} onClick={() => onOpenDiff(comparison, file, directory)}>
        <span className="repo-change-mark" data-status={file.status} aria-hidden="true">{STATUS_MARK[file.status]}</span>
        <span className="visually-hidden">{word}</span>
        <FileGlyph name={file.path} className="repo-change-glyph" />
        <span className="repo-change-path" title={file.old_path === null ? file.path : t("Renamed from {path}", { path: file.old_path })}>
          {file.old_path !== null && <span className="repo-change-old">{sameFolder && folder !== "" && <span className="visually-hidden">{folder}</span>}{sameFolder ? file.old_path.slice(folder.length) : file.old_path} → </span>}{folder !== "" && <span className="visually-hidden">{folder}</span>}{entry.name}
        </span>
        {file.binary === true
          ? <span className="repo-change-counts">{t("Binary")}</span>
          : file.additions !== null && file.deletions !== null && <span className="repo-change-counts">
            <span className="repo-change-added">+{file.additions.toLocaleString(locale)}</span>
            <span className="repo-change-deleted">−{file.deletions.toLocaleString(locale)}</span>
          </span>}
      </button>
    </li>;
  });

  return (
    <div className="repo-changes" role="group" aria-label={t("Changes")} aria-busy={load.status === "pending" && !awaitingBase}>
      <div className="repo-changes-bar">
        <div className="segmented repo-changes-scopes" role="group" aria-label={t("Compare")}>
          <button type="button" aria-pressed={scope === "workspace"} onClick={() => choose("workspace")}>{t("Working tree")}</button>
          <button type="button" aria-pressed={scope === "staged"} onClick={() => choose("staged")}>{t("Staged")}</button>
          <button type="button" aria-pressed={scope === "commit"} onClick={() => choose("commit")}>{t("Commits")}</button>
          <button type="button" aria-pressed={scope === "branch"} onClick={() => choose("branch")}>{t("Branch")}</button>
        </div>
        <div className="repo-changes-tools">
          <button type="button" className="icon-button" aria-label={allOpen ? t("Collapse all folders") : t("Expand all folders")} title={allOpen ? t("Collapse all folders") : t("Expand all folders")} disabled={folders.length === 0} onClick={() => setFolded(allOpen ? new Set(folders) : new Set())}>
            {allOpen ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
          </button>
          <button type="button" className="icon-button" aria-label={t("Refresh changes")} title={t("Refresh changes")} disabled={asked === null || load.status === "pending"} onClick={() => asked !== null && read(asked)}>
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>
      {scope === "commit" && (
        <form className="repo-changes-commits" onSubmit={compare}>
          <label className="field">
            <span className="field-label">{t("From commit")}</span>
            <input className="input" value={base} onChange={(event) => setBase(event.target.value)} placeholder="HEAD~1" autoComplete="off" spellCheck={false} required />
          </label>
          <label className="field">
            <span className="field-label">{t("To commit")}</span>
            <input className="input" value={head} onChange={(event) => setHead(event.target.value)} placeholder="HEAD" autoComplete="off" spellCheck={false} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={base.trim() === ""}>{t("Compare")}</button>
        </form>
      )}
      {scope === "branch" && (
        <form className="repo-changes-commits repo-changes-base-form" onSubmit={compareBranch}>
          <div className="field">
            <span className="field-label" id={baseLabelId}>{t("Base branch")}</span>
            <div className="repo-changes-base" ref={pickerRef}>
              <input ref={baseInputRef} className="input repo-changes-base-input" role="combobox" aria-labelledby={baseLabelId} aria-autocomplete="list" aria-expanded={pickerOpen} aria-controls={listId}
                aria-activedescendant={pickerOpen && activeOption !== undefined ? `${listId}-${activeOption.name}` : undefined}
                value={baseRef} placeholder={t("Branch or commit")} autoComplete="off" spellCheck={false} required
                onChange={(event) => { setBaseRef(event.target.value); setActive(0); if (!pickerOpen) openPicker(); }}
                onClick={() => { if (!pickerOpen) openPicker(); }}
                onKeyDown={onBaseKeyDown} />
              <button type="button" className="icon-button repo-changes-base-toggle" aria-label={t("Choose a branch")} title={t("Choose a branch")} aria-expanded={pickerOpen} aria-controls={listId}
                onClick={() => { if (pickerOpen) setPickerOpen(false); else { openPicker(); baseInputRef.current?.focus(); } }}>
                <ChevronDown aria-hidden="true" />
              </button>
            </div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={typed === ""}>{t("Compare")}</button>
          {/* a row is made active by a pointer moving over it, not by the list opening under a resting one */}
          {pickerOpen && (
            <div id={listId} ref={refsRef} className="menu repo-changes-refs" role="listbox" aria-labelledby={baseLabelId} aria-busy={refs.status === "pending"}>
              {refs.status === "pending" && <div className="repo-changes-refs-note" role="status">{t("Loading…")}</div>}
              {refs.status === "failed" && <div className="repo-changes-refs-note repo-changes-error" role="alert">{diffErrorMessage(t, refs.error)}</div>}
              {refsListing !== null && refsListing.refs.length === 0 && <div className="repo-changes-refs-note">{t("This repository has no branches yet; a commit can still be typed.")}</div>}
              {refsListing !== null && refsListing.refs.length > 0 && options.length === 0 && <div className="repo-changes-refs-note">{t("No branch matches; Compare takes the name as typed.")}</div>}
              {options.map((ref) => (
                <div key={ref.name} id={`${listId}-${ref.name}`} className="menu-item repo-changes-ref" role="option" aria-selected={ref === activeOption} title={ref.name}
                  onPointerMove={() => setActive(options.indexOf(ref))} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(ref)}>
                  <GitBranch aria-hidden="true" />
                  <span className="menu-item-main">{refName(ref.name)}</span>
                  <span className="menu-item-hint">{shortHash(ref.oid)}</span>
                </div>
              ))}
              {refsListing?.truncated && <div className="repo-changes-refs-note" role="status">{t("Only the first {count} branches are listed; another can be typed by name.", { count: refsListing.limits.max_refs.toLocaleString(locale) })}</div>}
            </div>
          )}
        </form>
      )}
      {repository !== null && (
        <p className="repo-changes-repo" title={repository.root}>
          <span className="repo-changes-branch"><GitBranch aria-hidden="true" />{branch}</span>
          <span className="repo-changes-root"><span dir="ltr">{repository.root}</span></span>
        </p>
      )}
      {listing?.comparison && answered?.scope === "branch" && (
        <p className="repo-changes-repo repo-changes-identity" title={`${listing.comparison.base_oid}\n${listing.comparison.merge_base_oid}`}>
          <span className="repo-changes-branch"><GitMerge aria-hidden="true" />{t("Compared from {hash}, the merge base with {base}", { hash: shortHash(listing.comparison.merge_base_oid), base: answered.base ?? "" })}</span>
        </p>
      )}
      {load.status === "failed"
        ? <p className="repo-changes-note repo-changes-error" role="alert">{diffErrorMessage(t, load.error)}</p>
        : <ul className="repo-changes-list" aria-label={t("Changed files")} data-scope={listing?.scope} data-merge-base={listing?.comparison?.merge_base_oid}>
          {awaitingBase && <li className="repo-changes-note">{t("Choose a base, then Compare.")}</li>}
          {load.status === "pending" && !awaitingBase && <li className="repo-changes-loading" role="status">
            <span className="visually-hidden">{t("Loading…")}</span>
            {skeletonRows(last === null ? null : last.files.length).map((width, index) => <span key={index} className="repo-change-skeleton" aria-hidden="true">
              <Skeleton className="repo-change-skeleton-mark" />
              <Skeleton className="repo-change-skeleton-glyph" />
              <Skeleton width={width} />
              <Skeleton className="repo-change-skeleton-counts" />
            </span>)}
          </li>}
          {listing !== null && answered !== null && rows(tree, listing.files, answered)}
          {listing !== null && listing.files.length === 0 && <li className="repo-changes-note">{nothingChangedWord(t, listing.scope)}</li>}
          {listing?.truncated && <li className="repo-changes-note" role="status">
            {listing.total === null
              ? t("The list was cut short; only the first {count} files are shown.", { count: listing.files.length.toLocaleString(locale) })
              : t("Showing the first {count} of {total} changed files.", { count: listing.files.length.toLocaleString(locale), total: listing.total.toLocaleString(locale) })}
          </li>}
        </ul>}
    </div>
  );
}
