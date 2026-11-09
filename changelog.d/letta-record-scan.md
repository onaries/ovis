### Fixed
- The check of another Letta pane's project record no longer blocks the server on a slow mount, and
  no longer counts a record swapped for a link or a decoy, or one gone from its path, as that folder's own.
  A record gone only for a moment, rewritten while it is read (even at the same size and time), cut short
  or unreadable as Letta's, or one that fails once opened, still counts as a claim.
