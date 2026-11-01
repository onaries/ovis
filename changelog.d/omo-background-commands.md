### Added
- An OmO pane's background tasks now count and list its background commands (`bash` with
  `run_in_background`, or a command auto-detached past the foreground window) and its monitors,
  as a Claude Code pane's background commands are, read from the session's own transcript.
  Detached eval cells, which already counted, are listed too. A persistent monitor is listed
  but not counted, and work started before the OmO process now holding the session reads as lost.
