### Fixed
- A message sent from Chat right after the page reconnects (after a server restart, or while the PC is
  busy) no longer fails with "this PC has not said yet what it supports": the server now says what it
  supports as soon as the connection opens, instead of only with the pane list, which can take seconds
  to read from herdr or fail. Older servers keep the previous behaviour.
