import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n.ts";

export function CapacityRetry({ allowed, failed, onRetry }: { allowed: boolean; failed: boolean; onRetry: () => Promise<boolean> }) {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [stopped, setStopped] = useState(false);
  const send = useRef(onRetry); send.current = onRetry;
  const failure = useRef(failed); failure.current = failed;
  useEffect(() => { if (!allowed) { setEnabled(false); setBusy(false); } }, [allowed]);
  useEffect(() => {
    if (!enabled || !allowed) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (!failure.current) { setEnabled(false); return; }
      setBusy(true);
      let ok = false;
      try { ok = await send.current(); } catch { ok = false; }
      if (cancelled) return;
      setBusy(false);
      if (ok) setAttempt((value) => value + 1);
      else { setEnabled(false); setStopped(true); }
    }, 30_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [enabled, allowed, attempt]);
  if (!failed && !enabled && !stopped) return null;
  return <div className="chat-capacity-retry chat-inline-state">
    {(failed || enabled) && <button type="button" className="btn chat-failure-retry" disabled={!allowed || busy} aria-pressed={enabled}
      onClick={() => { setStopped(false); setEnabled((value) => !value); }}>
      {t(enabled ? "Stop retrying" : "Retry every 30 seconds")}
    </button>}
    {enabled && <span role="status">{t("Sends 계속 every 30 seconds until Codex resumes.")}</span>}
    {stopped && <span role="status">{t("Retry stopped. Check the terminal.")}</span>}
  </div>;
}
