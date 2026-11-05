### Fixed
- On Linux, Copilot Chat can follow the live conversation through the TUI API of a Copilot you
  started with `--ui-server` yourself, rejecting stale history after session switches or
  connection loss. Ovis never adds that flag: the API has no authentication.
