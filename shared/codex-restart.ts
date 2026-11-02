/** A confirmation belongs to this exact terminal, Codex process and conversation. */
export interface CodexRestartTarget {
  readonly pane_id: string;
  readonly terminal_id: string;
  readonly process_id: number;
  readonly process_started_at: number;
  readonly session_id: string;
}

export interface CodexRestartResponse {
  readonly pane_id: string;
  readonly session_id: string;
}
