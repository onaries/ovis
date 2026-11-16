### Fixed
- A SIGTERM or SIGHUP that reaches the herdr plugin's launcher just as it starts its command is now
  passed on to that command, instead of ending the launcher and leaving the command running. The
  same holds for `ovis tui` starting its terminal client, and for a command handed on to the
  release Settings → Updates installed. A build from source stopped that way starts no further
  step, even when the step it reached had already ended.
