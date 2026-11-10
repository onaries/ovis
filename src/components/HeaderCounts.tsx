import type { SessionCounts } from "../lib/headerSessions.ts";
import { useT } from "../lib/i18n.ts";

/**
 * A phone's header: how many sessions run and how many finished unseen, over the PCs the sidebar shows
 * (lib/headerSessions.ts), in the sidebar's marks: a dot that runs, a check that finished. The waiting ones
 * are More's dot. A press opens the drawer, whose rows say which ones. Nothing while neither has any.
 */
export function HeaderCounts({ counts, onOpen }: { counts: SessionCounts; onOpen: () => void }) {
  const t = useT();
  if (counts.working + counts.done === 0) return null;
  const said = [
    counts.working > 0 ? t("{count} working", { count: counts.working }) : null,
    counts.done > 0 ? t("{count} done", { count: counts.done }) : null,
  ].filter((part): part is string => part !== null);
  const label = `${said.join(" · ")} · ${t("Open workspace list")}`;
  return (
    <button type="button" className="header-counts" aria-label={label} title={label} onClick={onOpen}>
      {counts.working > 0 && <span className="header-count is-working" aria-hidden="true"><span className="header-count-mark" />{counts.working}</span>}
      {counts.done > 0 && <span className="header-count is-done" aria-hidden="true"><span className="header-count-mark" />{counts.done}</span>}
    </button>
  );
}
