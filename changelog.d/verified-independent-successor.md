### Fixed

- Before updating a bridge that replaces a PC's independently managed Ovis,
  verify the replacement's live ownership. A stale descriptor cannot trigger
  a bundle installation or discard the prior server's reconnect guard.
