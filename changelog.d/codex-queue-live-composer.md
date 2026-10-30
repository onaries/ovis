### Fixed
- Codex follow-up queueing checks the live composer independently of changing tool output and
  background-terminal timers, and recognizes the working loader while hooks run.
- A normal Codex composer no longer becomes a generic Enter/Esc question when a stale blocked
  status remains after tool output.
