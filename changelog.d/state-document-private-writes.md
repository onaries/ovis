### Fixed
- Saved preferences, seen finishes and the removed-accounts list are written through a fresh,
  exclusively created temporary file, flushed to disk before it replaces the old one, so a link left in
  the state folder can no longer receive them and a crash cannot leave them empty.
