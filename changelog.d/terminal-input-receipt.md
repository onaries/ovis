### Fixed
- Typing that waited behind a message or key still on its way to a pane is no longer lost without a
  word when the connection drops before its turn: the terminal now holds it for review, as it does
  for typing the server never received.
