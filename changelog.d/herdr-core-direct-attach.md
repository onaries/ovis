### Changed
- With `OVIS_RUNTIME=herdr-core`, a terminal's live view streams over the server's own connection to
  herdr-core, instead of an `hc attach` process and a PTY host for every open pane.
