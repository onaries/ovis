### Fixed
- With `OVIS_RUNTIME=herdr-core`, starting an agent no longer types into a pane whose own program is
  not a shell, a terminal Ovis started into a Herdr app space or tab with nothing else live in it
  keeps its place when the app adopts it, and resuming a Claude session checks the store a new
  terminal really gets (herdr-core's environment, not Ovis's).
