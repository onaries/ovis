### Fixed
- `ovis link` run from a checkout passes a SIGTERM or SIGHUP that comes while it starts the
  installed release on to that release, which takes its code back, instead of ending and leaving
  the release's link running without it.
- A Copilot pane's session is read again from its log when the log is cut back to the lines it
  had before a half-written one, also when the cut comes within the same instant as that line.
