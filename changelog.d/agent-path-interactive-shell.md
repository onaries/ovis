### Fixed
- The desktop app on a Mac offers Claude Code, and any other agent, whose folder only `.zshrc`
  puts on PATH: the agent list now reads the PATH an interactive shell sets, as a terminal pane
  does, once per start of Ovis and again on Check again or an install. Settings > Agents says when
  that shell's PATH could not be read, and the shell runs with `OVIS_PATH_PROBE=1` so a `.zshrc`
  can skip lines that start background programs there.
