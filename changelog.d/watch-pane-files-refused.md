### Fixed
- A device paired to watch only can no longer list the file paths under a pane's folder through
  `/api/pane/files`, or read a plugin action run's output through `/api/plugin/action`, on this PC
  or another: they are refused as a folder listing already was.
