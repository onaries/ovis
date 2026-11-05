import { useEffect, useRef, useState } from "react";

import type { EditableText } from "../../shared/files.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";

/**
 * Text typed and not saved yet, by PC and file, kept above the viewer: Close, Back, the viewer moved
 * beside the pane or another file opened all unmount the editor, and none of them throws the text
 * away. Only Save and Cancel do. Kept with the file as it was opened, so a save of it still names
 * that revision (and meets a conflict if the file changed since).
 */
const drafts = new Map<string, { file: EditableText; draft: string }>();
const draftKey = (machineId: string, path: string): string => `${machineId}\u0000${path}`;

/** A reload or a closed tab would lose every draft kept: while one is, the browser asks first. */
const askBeforeUnload = (event: BeforeUnloadEvent): void => event.preventDefault();
function keepDraft(key: string, kept: { file: EditableText; draft: string } | null): void {
  const had = drafts.size > 0;
  if (kept === null) drafts.delete(key);
  else drafts.set(key, kept);
  if (!had && drafts.size > 0) window.addEventListener("beforeunload", askBeforeUnload);
  if (had && drafts.size === 0) window.removeEventListener("beforeunload", askBeforeUnload);
}

/** Whether text typed into `path` on `machineId` waits to be saved, for the viewer to open its editor again. */
export function hasDraft(machineId: string, path: string): boolean {
  return drafts.has(draftKey(machineId, path));
}

type EditorState =
  | { kind: "opening" }
  | { kind: "editing" }
  | { kind: "confirming" }
  | { kind: "saving" }
  | { kind: "conflict" }
  | { kind: "refused"; code: string | null; opened: boolean };

export interface TextFileEditorProps {
  /** the file's path as the viewer found it */
  path: string;
  paneId: string;
  name: string;
  /** the editor is done: saved, or left without saving */
  onDone: (saved: boolean) => void;
  /** whether the text now differs from the file as it was opened, so the viewer does not close over it */
  onChanged: (changed: boolean) => void;
}

/**
 * A text file edited in the viewer (Settings → File viewer → Edit text files): its whole text in a
 * text box, saved only after a second press, and only over the file as it was opened. A file that
 * changed meanwhile keeps the text typed here to copy, and offers the file as it is now, as Zed
 * does with a buffer whose file changed on disk (without its Overwrite: a save never replaces
 * changes this editor has not seen).
 */
export function TextFileEditor({ path, paneId, name, onDone, onChanged }: TextFileEditorProps) {
  const t = useT();
  const { fetchEditableText, saveEditableText } = useMachineApi();
  const key = draftKey(useMachineId(), path);
  const [file, setFile] = useState<EditableText | null>(null);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<EditorState>({ kind: "opening" });
  const [opens, setOpens] = useState(0);

  useEffect(() => {
    let live = true;
    const kept = opens === 0 ? drafts.get(key) : undefined;
    if (kept !== undefined) {
      setFile(kept.file);
      setDraft(kept.draft);
      setState({ kind: "editing" });
      return;
    }
    keepDraft(key, null);
    setState({ kind: "opening" });
    fetchEditableText(path, paneId).then((opened) => {
      if (!live) return;
      setFile(opened);
      setDraft(opened.text);
      setState({ kind: "editing" });
    }, (reason: unknown) => {
      if (live) setState({ kind: "refused", code: reason instanceof ApiError ? reason.code : null, opened: false });
    });
    return () => { live = false; };
  }, [path, paneId, fetchEditableText, opens, key]);

  const changed = file !== null && draft !== file.text;
  useEffect(() => onChanged(changed), [changed, onChanged]);
  useEffect(() => {
    if (file === null) return;
    keepDraft(key, changed ? { file, draft } : null);
  }, [key, file, draft, changed]);
  // a save that answers after this editor went away tells nobody
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  /** Leaves the editor; `saved` or not, nothing typed is kept. */
  const finish = (saved: boolean): void => {
    keepDraft(key, null);
    onChanged(false);
    onDone(saved);
  };

  const save = async (): Promise<void> => {
    if (file === null) return;
    setState({ kind: "saving" });
    try {
      // the entry kept for this text: an editor opened again meanwhile keeps an entry of its own
      const submitted = drafts.get(key);
      await saveEditableText({ pane_id: paneId, path: file.path, revision: file.revision, text: draft });
      if (mounted.current) finish(true);
      // the editor was closed meanwhile: only the draft this save wrote goes, not one kept since
      else if (submitted !== undefined && drafts.get(key) === submitted) keepDraft(key, null);
    } catch (reason) {
      if (!mounted.current) return;
      const code = reason instanceof ApiError ? reason.code : null;
      setState(code === "stale_revision" ? { kind: "conflict" } : { kind: "refused", code, opened: true });
    }
  };

  /** Why the file cannot be opened or saved here, in words, by the server's code (shared/files.ts). */
  const refusal = (code: string | null): string => {
    switch (code) {
      case "outside_pane": return t("Only a file inside the pane's folder can be edited.");
      case "too_large": return t("This file is too large to edit here.");
      case "not_text": return t("Only a UTF-8 text file can be edited here.");
      case "mixed_line_endings": return t("This file mixes line endings. Edit it in the terminal.");
      case "unsupported_platform": return t("Saving files from the app isn't available on this PC yet.");
      case "not_writable": case "linked_file": case "not_owner": case "access_list": return t("This file can't be written here.");
      case "drive_only": case "read_only": return t("Only a device that drives this PC can edit its files.");
      default: return t("The file could not be saved.");
    }
  };

  const cancel = <button type="button" className="btn btn-ghost" onClick={() => finish(false)}>{t("Cancel")}</button>;
  const bar = (() => {
    switch (state.kind) {
      case "opening":
        return <p className="file-viewer-note" role="status">{t("Opening…")}</p>;
      case "editing":
        return <div className="file-editor-bar">
          <span className="file-editor-status">{changed ? t("Unsaved changes") : null}</span>
          {cancel}
          <button type="button" className="btn btn-primary" disabled={!changed} onClick={() => setState({ kind: "confirming" })}>{t("Save")}</button>
        </div>;
      case "confirming":
        return <div className="file-editor-bar" role="group" aria-label={t("Save changes to {name}?", { name })}>
          <span className="file-editor-status">{t("Save changes to {name}?", { name })}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setState({ kind: "editing" })}>{t("Keep editing")}</button>
          <button type="button" className="btn btn-primary" autoFocus onClick={() => void save()}>{t("Save")}</button>
        </div>;
      case "saving":
        return <div className="file-editor-bar">
          <span className="file-editor-status" role="status">{t("Saving…")}</span>
        </div>;
      case "conflict":
        return <div className="file-editor-bar file-editor-alert" role="alert">
          <span className="file-editor-status">{t("This file changed since you opened it, so your changes were not saved. Copy them before you reload it.")}</span>
          {cancel}
          <button type="button" className="btn" onClick={() => setOpens((count) => count + 1)}>{t("Reload file")}</button>
        </div>;
      case "refused":
        return <div className="file-editor-bar file-editor-alert" role="alert">
          <span className="file-editor-status">{refusal(state.code)}</span>
          {cancel}
          {state.opened && <button type="button" className="btn" onClick={() => setState({ kind: "editing" })}>{t("Keep editing")}</button>}
        </div>;
    }
  })();

  return <div className="file-editor">
    {bar}
    {file !== null && <textarea className="file-editor-text" value={draft} onChange={(event) => setDraft(event.target.value)}
      readOnly={state.kind === "saving" || state.kind === "confirming"} aria-label={t("Text of {name}", { name })}
      spellCheck={false} autoCapitalize="off" autoCorrect="off" />}
  </div>;
}
