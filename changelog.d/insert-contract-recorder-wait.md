### Maintenance
- The terminal insert contract test reads its recorder's log again until a deadline instead of
  waiting for a file watch event, which Bun could miss for the last write, and a timeout now names
  what the wait was for and how much text arrived.
