import type { SessionHistoryRow } from "./session-history.ts";

export interface CodexManualTarget {
  readonly pane_id: string;
  readonly terminal_id: string;
  readonly process_id: number;
  readonly process_started_at: number;
}

export interface CodexManualState {
  readonly target: CodexManualTarget;
  readonly cwd: string;
  readonly session_id: string | null;
  readonly sessions: SessionHistoryRow[];
}

export interface CodexManualSelection {
  readonly target: CodexManualTarget;
  readonly session_id: string;
}
