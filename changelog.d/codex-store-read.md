### Fixed
- Codex Chat no longer falls back to the terminal once Codex has let go of its conversation store: Ovis
  reads the store even when no Codex holds it open, still without writing to it.
