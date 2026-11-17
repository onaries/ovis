### Fixed
- Large PC rosters reuse matching pane fields in agent rows on clients that request the compact
  format, reducing duplicate state sent over HTTP and machine-event WebSocket/SSE connections.
  Older clients and bridges retain their existing full agent rows.
