/**
 * Browser scripts whose pass on the lane's second run still counts as a pass, each until its end
 * date (inclusive, UTC) and with an issue about it. Any other script that fails and
 * then passes when run again fails the lane (scripts/ci-browser-parallel.ts). An entry ends at most
 * QUARANTINE_MAX_DAYS ahead; once a script has stopped flaking, its entry goes.
 */
export interface QuarantineEntry {
  readonly until: string;
  readonly issue: number;
}

export const QUARANTINE_MAX_DAYS = 30;

export const QUARANTINE: Readonly<Record<string, QuarantineEntry>> = {
  "scripts/chat-virtual-browser-qa.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/file-viewer-regression.ts": { until: "2026-12-18", issue: 4185 },
  "scripts/gjc-status-browser-regression.ts": { until: "2026-12-18", issue: 4184 },
  "scripts/pane-mute-demo-regression.ts": { until: "2026-12-18", issue: 4131 },
  "scripts/phone-worktree-sheet-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/terminal-touch-burst-history-regression.ts": { until: "2026-12-18", issue: 4174 },
};
