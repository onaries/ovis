### Added
- New workspace and New tab offer an effort level for DeepSeek Harness (off, low, high, max), saved
  where dsh-tui's own `/effort` keeps it, since dsh-tui has no flag for it: it becomes dsh-tui's
  default for later sessions too, even if the session does not start, and a default set in dsh-tui's
  /settings wins over it. Two dsh-tui launches started at about the same time may both start on the
  later level. New worktree offers no level: its dsh-tui starts on dsh-tui's own default.
