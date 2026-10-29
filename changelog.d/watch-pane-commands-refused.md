### Fixed
- A device paired to watch only can no longer read a pane's command rows (custom commands' first
  lines and file paths) through `/api/pane/commands`, on this PC or another: they are refused as a
  folder's commands already were, and its chat no longer keeps asking for them.
