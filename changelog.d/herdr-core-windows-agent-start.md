### Added
- With `OVIS_RUNTIME=herdr-core` on Windows, **New workspace** and **New tab with agent** start the
  agent in the pane's PowerShell or cmd, typing the line that shell reads and telling a busy shell
  and a started agent from this PC's process table. An argument the shell would change is refused
  before anything is typed, and in PowerShell so is one holding `%` or `^`, or `&`, `|`, `<` or `>`
  outside the quotes PowerShell gives an argument with a space (any `"` in the line counts), which
  cmd would read again if the agent starts through a `.cmd` file. Claude Code's Ultracode settings file sits in a folder named
  with a space, so a profile folder like `R&D` still starts it. A POSIX shell (Git Bash, WSL)
  takes no start there, and a Windows PC offers no agent on another machine of its core.
