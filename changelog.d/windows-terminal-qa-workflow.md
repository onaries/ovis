### Maintenance
- The native Windows terminal check (a mirrored PowerShell pane's wheel, touch, panning and IME
  input in Chromium) now runs in CI on a Windows runner, `windows-terminal-qa.yml`, for pull
  requests that touch the mirror, the terminal's viewport code or the xterm patch, and weekly. It
  now picks Original width for the pane first: since wide mirrors fold on a phone by default, its
  panning steps could not pass.
