### Changed
- libghostty no longer has xterm.js redraw the rows it hides, so a pane printing fast costs about
  what it costs with xterm.js alone, and screen readers read the rows
  libghostty draws and hear the lines a program writes, as xterm's screen reader mode does.
