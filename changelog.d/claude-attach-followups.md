### Fixed
- A message queued for a `claude attach` pane waits for the conversation of the job it opened, as it
  does for any Claude Code pane, instead of going wherever the pane ends up.
- Chat follows a `claude attach <name>` pane whose name is followed by debug options or
  `--setting-sources`, as Claude Code reads it.
- A `/resume` of a background session no longer reads that job's state without a size limit, nor
  waits on a FIFO put in its place.
