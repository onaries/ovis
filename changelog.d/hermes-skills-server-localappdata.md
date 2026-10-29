### Fixed
- On Windows, Hermes skills show in the command menu again when `%LOCALAPPDATA%` is redirected: Ovis
  cannot read a Windows pane's environment, and now looks in the server's `%LOCALAPPDATA%\hermes`, as
  it already did for Hermes transcripts, instead of `<profile>\AppData\Local\hermes`.
