### Fixed
- After Claude Code's `/branch`, Chat follows the branch's continuation in the branch's own project
  instead of a file of the same id in another project, and reads a transcript's records however
  their keys are spelled or spaced.
- A `claude attach <name>` pane with a debug value given apart from its option (`-d api,hooks`,
  `--debug api`) keeps its terminal: Claude Code then looks no name up.
- A message queued for a Claude Code conversation is held, not sent, once the conversation in the
  pane can no longer be told (its PID record or its job's state cannot be read).
