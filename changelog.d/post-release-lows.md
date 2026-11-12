### Fixed
- An OpenCode chat paused with Ctrl+Z stays open when its shell runs many other processes, when
  herdr names OpenCode's process without an ID, and when its pane was checked several times at once.
- A failed SSH tunnel to a PC shows ssh's own error first, without the lines ssh adds in verbose
  mode.
