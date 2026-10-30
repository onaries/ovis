### Added
- Settings → Subscription usage has **Read Claude's limits from its status line** for networks where
  Anthropic's usage endpoint is refused (a 403 that showed as an expired sign-in). Turned on, the
  server's PC wraps the status line set in Claude's `settings.json` (under `CLAUDE_CONFIG_DIR` too)
  and runs that command unchanged, keeping only the five-hour and weekly windows and the account,
  owner-only, in `~/.herdr/statusline-last.json`; turned off, it puts `settings.json` back as it was
  and deletes what it added, never a file there it did not write. A Claude account refused that way offers **Read from Claude's status line
  instead** in the usage popover. A reading counts only for the account that drew it and only until
  its window resets; the endpoint stays the fallback. A watching device cannot turn it on. By
  @CharleoYang.
- omp's context ring shows a percent, read from the context figure in omp's own status bar while
  the pane is scrolled to the bottom. By @CharleoYang.
