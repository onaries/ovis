import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CodexManualState } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { formatChatTimestamp } from "../lib/chatTimestamp.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { userErrorMessage } from "../lib/userError.ts";
import "./CodexManualDialog.css";

export function CodexManualDialog({ paneId, onClose }: { paneId: string; onClose: () => void }) {
  const api = useMachineApi();
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const surface = useFocusTrap<HTMLFormElement>(true, { initialFocus: input });
  const [answer, setAnswer] = useState<CodexManualState | null>(null);
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  useEffect(() => {
    let alive = true;
    setAnswer(null); setError(null);
    void api.fetchCodexManual(paneId).then((found) => {
      if (alive) { setAnswer(found); setSelected((value) => value || found.session_id || ""); }
    }, (reason: unknown) => { if (alive) setError(reason instanceof ApiError ? reason.detail : userErrorMessage(reason).message); });
    return () => { alive = false; };
  }, [api, paneId, reload]);
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault(); event.stopPropagation();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onClose, pending, surface]);
  useEffect(() => { if (pending) surface.current?.focus(); }, [pending, surface]);
  const save = async (automatic: boolean): Promise<void> => {
    if (!answer || pending) return;
    setPending(true); setError(null);
    try {
      if (automatic) await api.clearCodexManual(answer.target);
      else await api.connectCodexManual({ target: answer.target, session_id: selected.trim() });
      onClose();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.detail : userErrorMessage(reason).message);
      setPending(false);
    }
  };
  const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selected.trim());
  return createPortal(<div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <form ref={surface} className="modal codex-manual-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} onSubmit={(event) => { event.preventDefault(); if (valid) void save(false); }}>
      <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{t("Connect conversation")}</h2></header>
      <div className="modal-body">
        <p className="field-hint" id={`${id}-body`}>{t("Choose the conversation running in this pane. This only connects its chat history; it does not switch the terminal.")}</p>
        {answer && <p className="field-hint codex-manual-cwd">{answer.cwd}</p>}
        <label className="field-label" htmlFor={`${id}-session`}>{t("Session ID")}</label>
        <input ref={input} id={`${id}-session`} className="input" value={selected} onChange={(event) => setSelected(event.target.value)} placeholder={t("Paste a full session ID")} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={pending} />
        {answer === null && error === null && <p className="field-hint" role="status">{t("Reading sessions…")}</p>}
        {answer && <fieldset className="codex-manual-sessions" disabled={pending}>
          <legend className="field-label">{t("Recent conversations")}</legend>
          {answer.sessions.length === 0 && <p className="field-hint">{t("No saved conversations in this folder. You can paste a session ID above.")}</p>}
          {answer.sessions.map((row) => <label className="codex-manual-session" key={row.id}>
            <input type="radio" name={`${id}-session`} value={row.id} checked={selected.trim() === row.id} onChange={() => setSelected(row.id)} />
            <span><span className="codex-manual-title">{row.title ?? row.firstMessage ?? row.id}</span><span className="field-hint">{formatChatTimestamp(row.updatedAt, Date.now(), locale, t)?.label ?? row.updatedAt}</span><code>{row.id}</code></span>
          </label>)}
        </fieldset>}
        <p className="field-hint">{t("The connection is cleared if the pane changes or Ovis restarts. Sending messages still uses the terminal's own safety checks.")}</p>
        {error && <p className="field-hint codex-manual-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer">
        {answer?.session_id && <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => void save(true)}>{t("Use automatic detection")}</button>}
        {answer === null && error && <button type="button" className="btn" onClick={() => setReload((value) => value + 1)}>{t("Retry")}</button>}
        <button type="button" className="btn" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
        <button type="submit" className="btn btn-primary" disabled={!answer || !valid || pending}>{t(pending ? "Connecting…" : "Connect")}</button>
      </footer>
    </form>
  </div>, document.body);
}
