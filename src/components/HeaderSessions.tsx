import type { SessionCounts } from "../lib/headerSessions.ts";
import { useT } from "../lib/i18n.ts";

/**
 * The PC's sessions at a glance (lib/headerSessions.ts): a figure per state that has any, in the
 * sidebar's colours and marks (a dot that runs, a question mark that waits, a dot that finished).
 * Only the waiting figure is a button: it opens the next session that waits for an answer, as a
 * messenger's "next unread" does. With no other session waiting it stays a button, aria-disabled,
 * so a keyboard's focus is not dropped by the press that opened the last one. Nothing at all while
 * every session rests. `compact` (a phone, at the end of the tab row, where the header's line is the
 * title's) draws one pill: the waiting figure when one waits, else the running one, else the done one.
 */
export function HeaderSessions({ counts, onNextWaiting, compact = false }: { counts: SessionCounts; onNextWaiting: (() => void) | null; compact?: boolean }) {
  const t = useT();
  if (counts.working + counts.waiting + counts.done === 0) return null;
  const waiting = t("{count} waiting for you", { count: counts.waiting });
  const label = onNextWaiting ? `${waiting} · ${t("Open the next session waiting for you")}` : waiting;
  const top = counts.waiting > 0 ? "waiting" : counts.working > 0 ? "working" : "done";
  const shows = (state: "working" | "waiting" | "done") => !compact || state === top;
  return (
    <span className={`header-sessions${compact ? " is-compact" : ""}`} role="group" aria-label={t("Sessions on this PC")}>
      {counts.working > 0 && shows("working") && <Figure state="working" count={counts.working} label={t("{count} working", { count: counts.working })} />}
      {counts.waiting > 0 && shows("waiting") && (
        <button type="button" className="header-session-count is-blocked" title={label} aria-label={label}
          aria-disabled={onNextWaiting ? undefined : true} onClick={onNextWaiting ?? undefined}>
          <span className="header-session-mark" aria-hidden="true">?</span>{counts.waiting}
        </button>
      )}
      {counts.done > 0 && shows("done") && <Figure state="done" count={counts.done} label={t("{count} done", { count: counts.done })} />}
    </span>
  );
}

function Figure({ state, count, label }: { state: "working" | "done"; count: number; label: string }) {
  return (
    <span className={`header-session-count is-${state}`} title={label}>
      <span className="header-session-dot" aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
