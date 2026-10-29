### Fixed
- A device paired to watch only can no longer list a repository's checkouts (their folders and
  branches, those not open in herdr too) through `/api/worktree/list`, on this PC or another: it is
  refused as a folder listing already was. Its sidebar no longer asks for them and shows no branch
  names.
